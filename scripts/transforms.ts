/**
 * Pure transformations from the legacy schema to the current one.
 *
 * Separated from the migration CLI so every rule here is unit-testable without AWS.
 * Key construction and history derivation are imported from `src/` rather than
 * reimplemented, so migrated data is keyed identically to anything the live API writes.
 */

import { ulid } from 'ulid'
import { envelope } from '../src/shared/db'
import {
  DEFAULT_LIBRARY_PK,
  bodyweightSk,
  exerciseSk,
  gsi1SessionKeys,
  programSk,
  programVersionSk,
  sessionPk,
  sessionSk,
  userPk,
} from '../src/shared/keys'
import { parseRestSeconds } from '../src/shared/rest'
import { historyItemsFor } from '../src/sessions/history'
import type { Session, SessionExercise, SetEntry, TimeOfDay, WeightUnit } from '../src/shared/types'

export type LegacyItem = Record<string, unknown>

/** Anything destined for the new table; keys are always present, the rest varies by entity. */
export type TargetItem = { PK: string; SK: string }

export const LEGACY_TABLE = 'workout-tracker-db'
export const LEGACY_PROGRAM_PK = 'PROGRAM#spring2026'

/** Every partition the legacy client ever wrote to. Scan is denied by IAM, by design. */
export const LEGACY_SESSION_TYPES = [
  'lower-a',
  'upper-a',
  'lower-b',
  'upper-b',
  'upper-c',
  'upper-a-5',
  'upper-b-5',
]

/**
 * Superseded by the in-session `fiveDay` volume toggle. Their program configs still
 * exist in the legacy table but no session was ever logged against either.
 */
export const SKIPPED_PROGRAM_IDS = new Set(['upper-a-5', 'upper-b-5'])

/**
 * Sessions containing only `{PK, SK, notes: ""}` — opened and abandoned before anything
 * was logged, with no date, exercises, or sessionType. They carry no data, and a
 * migration that assumed the documented shape would crash on them.
 */
export const isStubSession = (item: LegacyItem): boolean =>
  !Array.isArray(item['exercises']) || (item['exercises'] as unknown[]).length === 0

/**
 * The single deliberate data correction: a fat-fingered "2250" on one Iso-Lateral Low
 * Row set, the only implausible weight in the dataset. Everything else migrates as
 * recorded — a migration should not be in the business of guessing at fixes.
 */
export const WEIGHT_TYPO_FIX = {
  sessionType: 'upper-b',
  date: '2026-07-17',
  slotId: 'ub-row',
  setNumber: 3,
  from: 2250,
  to: 225,
}

/**
 * The legacy table stores every weight/rep/RIR as a string, with "" for blank. The new
 * schema is `number | null`, so sorting and arithmetic work without parsing first.
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const toUnit = (value: unknown): WeightUnit => (value === 'kg' ? 'kg' : 'lbs')

export function migrateCatalogExercise(item: LegacyItem, now: string) {
  // `history` is deliberately dropped: it is the lossy 20-entry cache. History is
  // rebuilt from session records, which are the real source of truth.
  const { PK: _pk, SK: _sk, history: _history, ...rest } = item
  const name = String(item['name'])

  return {
    PK: DEFAULT_LIBRARY_PK,
    SK: exerciseSk(name),
    ...envelope('EXERCISE', now),
    ...rest,
    name,
    displayName: String(item['displayName'] ?? name),
    muscleGroups: (item['muscleGroups'] as string[]) ?? [],
    family: (item['family'] as string | null) ?? null,
    defaultRepRange: (item['defaultRepRange'] as [number, number] | null) ?? null,
    defaultSets: toNumber(item['defaultSets']),
  }
}

export function migrateProgram(item: LegacyItem, sub: string, now: string) {
  const id = String(item['SK']).replace('SESSION_TYPE#', '')

  const exercises = ((item['exercises'] as LegacyItem[]) ?? []).map((exercise) => ({
    ...exercise,
    // Copied verbatim, never recomputed from array position: a prior migration already
    // assigned these, and recomputing risks reintroducing the reorder-corruption bug.
    slotId: String(exercise['slotId']),
    name: String(exercise['name']),
    sets: toNumber(exercise['sets']) ?? 0,
    repRange: (exercise['repRange'] as [number, number] | null) ?? null,
    rir: toNumber(exercise['rir']),
    rest: String(exercise['rest'] ?? ''),
    restSeconds: parseRestSeconds(String(exercise['rest'] ?? '')),
    subs: (exercise['subs'] as unknown[]) ?? [],
  }))

  const program = {
    PK: userPk(sub),
    SK: programSk(id),
    ...envelope('PROGRAM', now),
    id,
    name: String(item['name'] ?? id),
    day: String(item['day'] ?? ''),
    focus: String(item['focus'] ?? ''),
    exercises,
  }

  // Every migrated session records programVersion 1, so version 1 must exist as an
  // archived snapshot for historical target lookups to resolve.
  const snapshot = { ...program, SK: programVersionSk(id, 1), entityType: 'PROGRAM_VERSION' }

  return [program, snapshot]
}

export function migrateSets(
  exercise: LegacyItem,
  context: { sessionType: string; date: string },
): SetEntry[] {
  const slotId = String(exercise['slotId'] ?? '')

  return ((exercise['sets'] as LegacyItem[]) ?? []).map((set, index) => {
    const setNumber = toNumber(set['setNumber']) ?? index + 1
    let weight = toNumber(set['weight'])

    const fix = WEIGHT_TYPO_FIX
    if (
      context.sessionType === fix.sessionType &&
      context.date === fix.date &&
      slotId === fix.slotId &&
      setNumber === fix.setNumber &&
      weight === fix.from
    ) {
      weight = fix.to
    }

    return {
      setNumber,
      weight,
      reps: toNumber(set['reps']),
      rir: toNumber(set['rir']),
      ...(set['isWarmup'] !== undefined ? { isWarmup: Boolean(set['isWarmup']) } : {}),
      ...(set['label'] !== undefined ? { label: String(set['label']) } : {}),
      ...(set['target'] !== undefined ? { target: toNumber(set['target']) } : {}),
    }
  })
}

export function toSession(item: LegacyItem): Session {
  const sessionType = String(item['sessionType'])
  const date = String(item['date'])

  const exercises: SessionExercise[] = ((item['exercises'] as LegacyItem[]) ?? []).map(
    (exercise) => ({
      // Supplementals have no program slot. A generated id keeps the history key uniform
      // and stops two ad-hoc entries of one exercise from colliding.
      slotId: String(exercise['slotId'] ?? `supp-${ulid().toLowerCase()}`),
      name: String(exercise['name']),
      ...(exercise['swappedName'] ? { swappedName: String(exercise['swappedName']) } : {}),
      ...(exercise['supplemental'] ? { supplemental: true } : {}),
      weightUnit: toUnit(exercise['weightUnit']),
      ...(exercise['note'] ? { note: String(exercise['note']) } : {}),
      sets: migrateSets(exercise, { sessionType, date }),
      ...(exercise['is531'] ? { is531: true } : {}),
      ...(exercise['week'] !== undefined
        ? { week: exercise['week'] as SessionExercise['week'] }
        : {}),
      ...(exercise['trainingMax'] !== undefined
        ? { trainingMax: toNumber(exercise['trainingMax']) ?? undefined }
        : {}),
    }),
  )

  // The PWA already treats the tag as authoritative and writes the boolean only as a
  // back-compat shim, so this normalises rather than changes meaning.
  const tags = [...((item['tags'] as string[]) ?? [])]
  if (item['deload'] === true && !tags.includes('deload')) tags.unshift('deload')

  return {
    sessionType,
    date,
    startedAt: String(item['startedAt'] ?? `${date}T00:00:00.000Z`),
    programVersion: 1,
    tags,
    ...(item['notes'] ? { notes: String(item['notes']) } : {}),
    ...(item['fiveDay'] !== undefined ? { fiveDay: Boolean(item['fiveDay']) } : {}),
    exercises,
  }
}

/** Returns the session item followed by every history entry derived from it. */
export function migrateSession(item: LegacyItem, sub: string, now: string) {
  const session = toSession(item)

  const sessionItem = {
    PK: sessionPk(sub, session.sessionType),
    SK: sessionSk(session.date),
    ...gsi1SessionKeys(sub, session.date),
    ...envelope('SESSION', now),
    ...session,
  }

  return [sessionItem, ...historyItemsFor(sub, session, now)]
}

export function migrateBodyweight(item: LegacyItem, sub: string, now: string) {
  const raw = item['timeOfDay']
  const timeOfDay: TimeOfDay = (['morning', 'afternoon', 'night'] as const).includes(
    raw as TimeOfDay,
  )
    ? (raw as TimeOfDay)
    : 'morning'

  return {
    PK: userPk(sub),
    SK: bodyweightSk(String(item['date']), timeOfDay),
    ...envelope('BODYWEIGHT', now),
    date: String(item['date']),
    timeOfDay,
    weight: toNumber(item['weight']) ?? 0,
    weightUnit: toUnit(item['weightUnit']),
  }
}

/**
 * Two items sharing a key would silently overwrite one another inside a batch write,
 * losing data with no error. Far cheaper to catch before writing than to discover after.
 */
export function findDuplicateKeys(items: TargetItem[]): string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []

  for (const item of items) {
    const key = `${item.PK} | ${item.SK}`
    if (seen.has(key)) duplicates.push(key)
    seen.add(key)
  }

  return duplicates
}
