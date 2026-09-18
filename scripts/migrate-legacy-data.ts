/**
 * One-time migration of the legacy single-user table into the multi-user schema.
 *
 * Safe by default: writes only with an explicit --apply. The legacy table is read with
 * read-only operations, and the `workout-tracker-migration` IAM role additionally
 * carries an explicit Deny on every write action against it, so "never modify the
 * source" is enforced rather than merely intended.
 *
 * Idempotent: every key is deterministic, so re-running converges rather than
 * duplicating. Safe to re-run after a partial failure.
 *
 *   AWS_PROFILE=workout-migration npx tsx scripts/migrate-legacy-data.ts \
 *     --owner-sub=<cognito-sub> --stage=dev [--apply]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { envelope } from '../src/shared/db'
import {
  coreRoutineArchiveSk,
  coreRoutineCompletionSk,
  fiveThreeOneConfigSk,
  tagsSk,
  userPk,
} from '../src/shared/keys'
import {
  LEGACY_PROGRAM_PK,
  LEGACY_SESSION_TYPES,
  LEGACY_TABLE,
  SKIPPED_PROGRAM_IDS,
  findDuplicateKeys,
  isStubSession,
  migrateBodyweight,
  migrateCatalogExercise,
  migrateProgram,
  migrateSession,
  toNumber,
  type LegacyItem,
  type TargetItem,
} from './transforms'

interface Options {
  ownerSub: string
  stage: string
  apply: boolean
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string) =>
    argv.find((a) => a.startsWith(`--${flag}=`))?.split('=').slice(1).join('=')

  const ownerSub = get('owner-sub')
  const stage = get('stage') ?? 'dev'

  if (!ownerSub) {
    throw new Error(
      'Missing --owner-sub=<cognito-sub>. Sign up in the target stage first, then pass the sub.',
    )
  }
  if (!['dev', 'prod'].includes(stage)) {
    throw new Error(`Invalid --stage=${stage} (expected dev or prod)`)
  }

  return { ownerSub, stage, apply: argv.includes('--apply') }
}

async function queryAllLegacy(doc: DynamoDBDocumentClient, pk: string): Promise<LegacyItem[]> {
  const items: LegacyItem[] = []
  let ExclusiveStartKey: Record<string, unknown> | undefined

  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: LEGACY_TABLE,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'PK' },
        ExpressionAttributeValues: { ':pk': pk },
        ExclusiveStartKey,
      }),
    )
    items.push(...((res.Items ?? []) as LegacyItem[]))
    ExclusiveStartKey = res.LastEvaluatedKey
  } while (ExclusiveStartKey)

  return items
}

async function writeAll(doc: DynamoDBDocumentClient, table: string, items: TargetItem[]) {
  let written = 0

  for (let i = 0; i < items.length; i += 25) {
    let request = {
      [table]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
    }

    // BatchWrite can partially succeed. Unprocessed items must be retried, or the
    // migration silently drops records.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await doc.send(new BatchWriteCommand({ RequestItems: request as never }))
      const unprocessed = (res.UnprocessedItems ?? {}) as typeof request
      if (!unprocessed[table]?.length) break
      request = unprocessed
      await new Promise((r) => setTimeout(r, 2 ** attempt * 100))
    }

    written += Math.min(25, items.length - i)
    process.stdout.write(`\r  ${written}/${items.length} items`)
  }

  process.stdout.write('\n')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const targetTable = `workout-tracker-api-${opts.stage}`
  const now = new Date().toISOString()

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })

  console.log(`${opts.apply ? 'APPLY' : 'DRY RUN'} — ${LEGACY_TABLE} → ${targetTable}`)
  console.log(`Owner sub: ${opts.ownerSub}\n`)

  const items: TargetItem[] = []
  const counts: Record<string, number> = {}
  const track = (label: string, n = 1) => {
    counts[label] = (counts[label] ?? 0) + n
  }

  // 1. Default catalog, seeded from the live table rather than the static seed file,
  //    which has drifted (it lacks Iso-Lateral Low Row, added at runtime in July).
  for (const exercise of await queryAllLegacy(doc, 'EXERCISE_LIB')) {
    items.push(migrateCatalogExercise(exercise, now))
    track('catalog exercises')
  }

  // 2. Programs, each with a version-1 snapshot.
  for (const program of await queryAllLegacy(doc, LEGACY_PROGRAM_PK)) {
    const id = String(program['SK']).replace('SESSION_TYPE#', '')
    if (SKIPPED_PROGRAM_IDS.has(id)) {
      console.log(`  · skipping program "${id}" (superseded by the fiveDay toggle)`)
      track('programs skipped')
      continue
    }
    items.push(...migrateProgram(program, opts.ownerSub, now))
    track('programs')
  }

  // 3. Sessions, plus the exercise history derived from them.
  for (const type of LEGACY_SESSION_TYPES) {
    for (const session of await queryAllLegacy(doc, `SESSION#${type}`)) {
      if (isStubSession(session)) {
        console.log(`  · skipping stub session ${session['PK']}/${session['SK']} (no data)`)
        track('stub sessions skipped')
        continue
      }
      const migrated = migrateSession(session, opts.ownerSub, now)
      items.push(...migrated)
      track('sessions')
      track('history entries', migrated.length - 1)
    }
  }

  // 4. Bodyweight.
  for (const entry of await queryAllLegacy(doc, 'BODYWEIGHT')) {
    items.push(migrateBodyweight(entry, opts.ownerSub, now))
    track('bodyweight entries')
  }

  // 5. Tags.
  const legacyTags = await doc.send(
    new GetCommand({ TableName: LEGACY_TABLE, Key: { PK: 'TAGS', SK: 'ALL' } }),
  )
  if (legacyTags.Item) {
    const tagsItem = {
      PK: userPk(opts.ownerSub),
      SK: tagsSk(),
      ...envelope('TAGS', now),
      tags: legacyTags.Item['tags'] ?? [],
    }
    items.push(tagsItem)
    track('tag documents')
  }

  // 6. Owner-only: 5/3/1 config, carried over verbatim.
  for (const config of await queryAllLegacy(doc, '531_CONFIG')) {
    const exercise = String(config['exercise'])
    const configItem = {
      PK: userPk(opts.ownerSub),
      SK: fiveThreeOneConfigSk(exercise),
      ...envelope('531_CONFIG', now),
      exercise,
      trainingMax: toNumber(config['trainingMax']) ?? 0,
      history: ((config['history'] as LegacyItem[]) ?? []).map((h) => ({
        date: String(h['date']),
        tm: toNumber(h['tm']) ?? 0,
      })),
    }
    items.push(configItem)
    track('5/3/1 configs')
  }

  // 7. Owner-only: routine definitions archived (clients ship them statically at
  //    runtime; this copy exists so nothing is lost) and completions preserved.
  for (const routine of await queryAllLegacy(doc, 'CORE_ROUTINE')) {
    const { PK: _pk, SK: _sk, ...rest } = routine
    const archiveItem = {
      PK: userPk(opts.ownerSub),
      SK: coreRoutineArchiveSk(String(routine['id'])),
      ...envelope('CORE_ROUTINE_ARCHIVE', now),
      ...rest,
    }
    items.push(archiveItem)
    track('core routines archived')
  }

  for (const completion of await queryAllLegacy(doc, 'CORE_ROUTINE_COMPLETION')) {
    const completionItem = {
      PK: userPk(opts.ownerSub),
      SK: coreRoutineCompletionSk(String(completion['routineId']), String(completion['date'])),
      ...envelope('CORE_ROUTINE_COMPLETION', now),
      routineId: String(completion['routineId']),
      date: String(completion['date']),
    }
    items.push(completionItem)
    track('routine completions')
  }

  console.log('\nSummary')
  for (const [label, count] of Object.entries(counts).sort()) {
    console.log(`  ${label.padEnd(26)} ${count}`)
  }
  console.log(`  ${'TOTAL ITEMS TO WRITE'.padEnd(26)} ${items.length}`)

  const duplicates = findDuplicateKeys(items)
  if (duplicates.length > 0) {
    throw new Error(
      `Refusing to write: ${duplicates.length} duplicate key(s) would overwrite each other, ` +
        `e.g. ${duplicates[0]}`,
    )
  }

  if (!opts.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to migrate.')
    return
  }

  console.log(`\nWriting to ${targetTable}...`)
  await writeAll(doc, targetTable, items)
  console.log('Done.')
}

main().catch((err) => {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
