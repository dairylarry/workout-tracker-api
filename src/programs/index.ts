import { ulid } from 'ulid'
import { z } from 'zod'
import { getCaller } from '../shared/auth'
import { TABLE, envelope, getItem, putItem, queryAll, transactWrite } from '../shared/db'
import {
  ApiError,
  created,
  noContent,
  ok,
  parseBody,
  pathParam,
  router,
  withErrorHandling,
  type ApiEvent,
} from '../shared/http'
import { PROGRAM_PREFIX, programSk, programVersionSk, userPk } from '../shared/keys'
import { findUnknownExercises, loadEffectiveLibrary } from '../shared/library'
import type { ItemEnvelope, Program, ProgramExercise } from '../shared/types'
import { parseRestSeconds } from '../shared/rest'

type ProgramItem = Program & ItemEnvelope & { PK: string; SK: string }

const subSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    sets: z.number().int().positive().optional(),
    repRange: z.tuple([z.number(), z.number()]).optional(),
    rir: z.number().optional(),
    perSide: z.boolean().optional(),
  }),
])

const exerciseSchema = z.object({
  /** Omitted when adding a new slot; the server assigns a stable id. */
  slotId: z.string().min(1).optional(),
  name: z.string().min(1),
  sets: z.number().int().nonnegative(),
  repRange: z.tuple([z.number(), z.number()]).nullable().default(null),
  rir: z.number().nullable().default(null),
  rest: z.string().default(''),
  subs: z.array(subSchema).default([]),
  superset: z.string().optional(),
  perSide: z.boolean().optional(),
  optional: z.boolean().optional(),
  is531: z.boolean().optional(),
  note: z.string().optional(),
})

const programSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Program id must be lowercase alphanumeric with hyphens')
    .optional(),
  name: z.string().min(1),
  day: z.string().default(''),
  focus: z.string().default(''),
  exercises: z.array(exerciseSchema).default([]),
})

/**
 * Slot ids are assigned once and never regenerated on edit — history lookup keys off
 * them, so a reordered or re-inserted slot must keep the id it already had.
 */
function withSlotIds(exercises: z.infer<typeof exerciseSchema>[]): ProgramExercise[] {
  return exercises.map((exercise) => ({
    ...exercise,
    slotId: exercise.slotId ?? `slot-${ulid().toLowerCase()}`,
    restSeconds: parseRestSeconds(exercise.rest),
  }))
}

/**
 * Rejects a program that references exercises which don't exist.
 *
 * Without this a typo'd name is accepted happily and only surfaces later, when a
 * session started from the program can't resolve the slot.
 */
async function assertExercisesExist(
  sub: string,
  exercises: Array<{ name: string; subs?: ProgramExercise['subs'] }>,
): Promise<void> {
  if (exercises.length === 0) return

  const library = await loadEffectiveLibrary(sub)
  const unknown = findUnknownExercises(exercises, new Set(library.map((e) => e.name)))

  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `Unknown exercises: ${unknown.join(', ')}. Add them to the library first.`,
    )
  }
}

async function listPrograms(event: ApiEvent) {
  const { sub } = getCaller(event)
  // The distinct PROGRAM_VERSION# prefix keeps archived versions out of this query.
  const items = await queryAll<ProgramItem>({
    pk: userPk(sub),
    skPrefix: PROGRAM_PREFIX,
    ascending: true,
  })
  return ok({ items: items.filter((p) => !p.deleted) })
}

async function createProgram(event: ApiEvent) {
  const { sub } = getCaller(event)
  const body = parseBody(event, programSchema)
  const id = body.id ?? `program-${ulid().toLowerCase()}`

  const existing = await getItem<ProgramItem>({ PK: userPk(sub), SK: programSk(id) })
  if (existing && !existing.deleted) {
    throw ApiError.conflict(`A program with id "${id}" already exists`)
  }

  await assertExercisesExist(sub, body.exercises)

  const item: ProgramItem = {
    PK: userPk(sub),
    SK: programSk(id),
    ...envelope('PROGRAM'),
    id,
    name: body.name,
    day: body.day,
    focus: body.focus,
    exercises: withSlotIds(body.exercises),
  }

  await putItem(item)
  return created(item)
}

/**
 * Archives the outgoing version, then writes the update — both in one transaction.
 *
 * Order matters even so: archiving first means a partial failure leaves a redundant
 * archive rather than a version that no longer exists anywhere, which sessions
 * referencing it would point at. The version condition additionally stops two
 * concurrent editors from silently discarding one another's changes.
 */
async function updateProgram(event: ApiEvent) {
  const { sub } = getCaller(event)
  const id = pathParam(event, 'id')
  const body = parseBody(event, programSchema)

  const current = await getItem<ProgramItem>({ PK: userPk(sub), SK: programSk(id) })
  if (!current || current.deleted) throw ApiError.notFound(`No program with id "${id}"`)

  await assertExercisesExist(sub, body.exercises)

  const nextVersion = current.version + 1

  const archived = {
    ...current,
    PK: userPk(sub),
    SK: programVersionSk(id, current.version),
    entityType: 'PROGRAM_VERSION',
  }

  const updated: ProgramItem = {
    ...current,
    name: body.name,
    day: body.day,
    focus: body.focus,
    exercises: withSlotIds(body.exercises),
    updatedAt: new Date().toISOString(),
    version: nextVersion,
  }

  await transactWrite([
    { Put: { TableName: TABLE, Item: archived } },
    {
      Put: {
        TableName: TABLE,
        Item: updated,
        // `version` is a DynamoDB reserved word.
        ConditionExpression: '#v = :expectedVersion',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': current.version },
      },
    },
  ])

  return ok(updated)
}

async function deleteProgram(event: ApiEvent) {
  const { sub } = getCaller(event)
  const id = pathParam(event, 'id')

  const current = await getItem<ProgramItem>({ PK: userPk(sub), SK: programSk(id) })
  if (!current || current.deleted) return noContent()

  // Soft-delete: historical sessions still resolve their slot metadata through this.
  await putItem({
    ...current,
    deleted: true,
    updatedAt: new Date().toISOString(),
    version: current.version + 1,
  })

  return noContent()
}

/** Lets a historical session render the targets that were actually in effect for it. */
async function getProgramVersion(event: ApiEvent) {
  const { sub } = getCaller(event)
  const id = pathParam(event, 'id')
  const version = Number.parseInt(pathParam(event, 'version'), 10)
  if (Number.isNaN(version) || version < 1) {
    throw ApiError.badRequest('Version must be a positive integer')
  }

  const current = await getItem<ProgramItem>({ PK: userPk(sub), SK: programSk(id) })
  if (current && current.version === version) return ok(current)

  const archived = await getItem<ProgramItem>({
    PK: userPk(sub),
    SK: programVersionSk(id, version),
  })
  if (!archived) throw ApiError.notFound(`No version ${version} of program "${id}"`)

  return ok(archived)
}

export const handler = withErrorHandling(
  router({
    'GET /programs': listPrograms,
    'POST /programs': createProgram,
    'PUT /programs/{id}': updateProgram,
    'DELETE /programs/{id}': deleteProgram,
    'GET /programs/{id}/versions/{version}': getProgramVersion,
  }),
)
