import { z } from 'zod'
import { getCaller } from '../shared/auth'
import { envelope, getItem, putItem, queryPage } from '../shared/db'
import { loadEffectiveLibrary } from '../shared/library'
import {
  ApiError,
  created,
  intQueryParam,
  noContent,
  ok,
  parseBody,
  pathParam,
  queryParam,
  router,
  withErrorHandling,
  type ApiEvent,
} from '../shared/http'
import {
  DEFAULT_LIBRARY_PK,
  exerciseHistoryPrefix,
  exerciseSk,
  userPk,
} from '../shared/keys'
import type { Exercise, ExerciseHistoryEntry, ItemEnvelope } from '../shared/types'

type ExerciseItem = Exercise & ItemEnvelope & { PK: string; SK: string }

const createSchema = z.object({
  displayName: z.string().min(1),
  muscleGroups: z.array(z.string()).default([]),
  family: z.string().nullable().default(null),
  defaultRepRange: z.tuple([z.number(), z.number()]).nullable().default(null),
  defaultSets: z.number().int().positive().nullable().default(null),
  unilateral: z.boolean().optional(),
})

/**
 * `name` is deliberately absent: it is the immutable identifier that program slots,
 * sessions, and every history key reference. A rename changes `displayName` only.
 */
const updateSchema = z.object({
  displayName: z.string().min(1).optional(),
  muscleGroups: z.array(z.string()).optional(),
  family: z.string().nullable().optional(),
  defaultRepRange: z.tuple([z.number(), z.number()]).nullable().optional(),
  defaultSets: z.number().int().positive().nullable().optional(),
  unilateral: z.boolean().optional(),
})

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

/**
 * A user's effective library is the golden catalog plus their own additions.
 *
 * The default catalog is shared and immutable; custom exercises live in the user's
 * own namespace and are never merged back into it.
 */
async function listExercises(event: ApiEvent) {
  const { sub } = getCaller(event)

  const library = await loadEffectiveLibrary(sub)

  const muscleGroup = queryParam(event, 'muscleGroup')
  const family = queryParam(event, 'family')

  const items = library
    .filter((e) => !muscleGroup || e.muscleGroups.includes(muscleGroup))
    .filter((e) => !family || e.family === family)
    .map((e) => ({
      name: e.name,
      displayName: e.displayName,
      muscleGroups: e.muscleGroups,
      family: e.family,
      defaultRepRange: e.defaultRepRange,
      defaultSets: e.defaultSets,
      unilateral: e.unilateral ?? false,
      custom: e.PK !== DEFAULT_LIBRARY_PK,
    }))

  return ok({ items })
}

async function createExercise(event: ApiEvent) {
  const { sub } = getCaller(event)
  const body = parseBody(event, createSchema)

  // `name` is the immutable identifier and `displayName` the only thing a rename
  // touches, so new exercises get a collision-proof slug-timestamp id.
  const name = `${slugify(body.displayName)}-${Date.now()}`

  const item: ExerciseItem = {
    PK: userPk(sub),
    SK: exerciseSk(name),
    ...envelope('EXERCISE'),
    name,
    displayName: body.displayName,
    muscleGroups: body.muscleGroups,
    family: body.family,
    defaultRepRange: body.defaultRepRange,
    defaultSets: body.defaultSets,
    ...(body.unilateral !== undefined ? { unilateral: body.unilateral } : {}),
  }

  await putItem(item)
  return created(item)
}

/**
 * Edits a custom exercise's metadata — the API equivalent of the PWA's Edit Exercise
 * flow. Default catalog entries are golden and reject edits, same as deletes.
 */
async function updateExercise(event: ApiEvent) {
  const { sub } = getCaller(event)
  const slug = pathParam(event, 'slug')
  const body = parseBody(event, updateSchema)

  const isDefault = await getItem<ExerciseItem>({
    PK: DEFAULT_LIBRARY_PK,
    SK: exerciseSk(slug),
  })
  if (isDefault) {
    throw ApiError.forbidden('Default catalog exercises cannot be edited')
  }

  const existing = await getItem<ExerciseItem>({ PK: userPk(sub), SK: exerciseSk(slug) })
  if (!existing || existing.deleted) {
    throw ApiError.notFound(`No custom exercise "${slug}"`)
  }

  const updated: ExerciseItem = {
    ...existing,
    ...body,
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  }

  await putItem(updated)
  return ok(updated)
}

async function deleteExercise(event: ApiEvent) {
  const { sub } = getCaller(event)
  const slug = pathParam(event, 'slug')

  // The golden catalog is never mutated by any API path.
  const isDefault = await getItem<ExerciseItem>({
    PK: DEFAULT_LIBRARY_PK,
    SK: exerciseSk(slug),
  })
  if (isDefault) {
    throw ApiError.forbidden('Default catalog exercises cannot be deleted')
  }

  const existing = await getItem<ExerciseItem>({ PK: userPk(sub), SK: exerciseSk(slug) })
  if (!existing) return noContent()

  // Soft-delete: history entries and past sessions still reference this exercise.
  await putItem({
    ...existing,
    deleted: true,
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  })

  return noContent()
}

/** History survives deletion of the exercise definition — it belongs to the sessions. */
async function getHistory(event: ApiEvent) {
  const { sub } = getCaller(event)
  const slug = pathParam(event, 'slug')

  const page = await queryPage<ExerciseHistoryEntry & ItemEnvelope>({
    pk: userPk(sub),
    skPrefix: exerciseHistoryPrefix(slug),
    limit: intQueryParam(event, 'limit', 50),
    ...(queryParam(event, 'cursor') ? { cursor: queryParam(event, 'cursor')! } : {}),
  })

  return ok(page)
}

export const handler = withErrorHandling(
  router({
    'GET /exercises': listExercises,
    'POST /exercises': createExercise,
    'PATCH /exercises/{slug}': updateExercise,
    'DELETE /exercises/{slug}': deleteExercise,
    'GET /exercises/{slug}/history': getHistory,
  }),
)
