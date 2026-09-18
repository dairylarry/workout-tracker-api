import { z } from 'zod'
import { requireOwner } from '../shared/auth'
import { envelope, getItem, putItem, queryAll } from '../shared/db'
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
import {
  CORE_ROUTINE_COMPLETION_PREFIX,
  DEFAULT_LIBRARY_PK,
  coreRoutineCompletionSk,
  exerciseSk,
  fiveThreeOneConfigSk,
  planDocSk,
  userPk,
} from '../shared/keys'
import type { Exercise, FiveThreeOneConfig, ItemEnvelope } from '../shared/types'

/**
 * Owner-only resources.
 *
 * Every handler here calls requireOwner, which checks isOwner on the caller's
 * profile server-side. Feature flags gate UI only and are never consulted for
 * authorization — a client can ignore them and call these endpoints directly.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const configSchema = z.object({
  trainingMax: z.number().positive(),
  history: z
    .array(
      z.object({
        date: z.string().regex(DATE_PATTERN, 'Date must be formatted YYYY-MM-DD'),
        tm: z.number().positive(),
      }),
    )
    .default([]),
})

const planSchema = z.object({
  content: z.string(),
})

const completionSchema = z.object({
  date: z.string().regex(DATE_PATTERN, 'Date must be formatted YYYY-MM-DD'),
})

async function get531Config(event: ApiEvent) {
  const profile = await requireOwner(event)
  const exercise = pathParam(event, 'exercise')

  const item = await getItem<FiveThreeOneConfig & ItemEnvelope>({
    PK: userPk(profile.sub),
    SK: fiveThreeOneConfigSk(exercise),
  })
  if (!item) throw ApiError.notFound(`No 5/3/1 config for "${exercise}"`)

  return ok(item)
}

async function put531Config(event: ApiEvent) {
  const profile = await requireOwner(event)
  const exercise = pathParam(event, 'exercise')
  const body = parseBody(event, configSchema)

  const existing = await getItem<ItemEnvelope>({
    PK: userPk(profile.sub),
    SK: fiveThreeOneConfigSk(exercise),
  })

  const item = {
    PK: userPk(profile.sub),
    SK: fiveThreeOneConfigSk(exercise),
    ...(existing ?? envelope('531_CONFIG')),
    exercise,
    trainingMax: body.trainingMax,
    history: body.history,
    updatedAt: new Date().toISOString(),
    version: (existing?.version ?? 0) + 1,
  }

  await putItem(item)
  return ok(item)
}

async function getPlan(event: ApiEvent) {
  const profile = await requireOwner(event)
  const item = await getItem<{ content: string } & ItemEnvelope>({
    PK: userPk(profile.sub),
    SK: planDocSk(),
  })
  return ok({ content: item?.content ?? '' })
}

async function putPlan(event: ApiEvent) {
  const profile = await requireOwner(event)
  const body = parseBody(event, planSchema)

  const existing = await getItem<ItemEnvelope>({ PK: userPk(profile.sub), SK: planDocSk() })

  const item = {
    PK: userPk(profile.sub),
    SK: planDocSk(),
    ...(existing ?? envelope('PLAN_DOC')),
    content: body.content,
    updatedAt: new Date().toISOString(),
    version: (existing?.version ?? 0) + 1,
  }

  await putItem(item)
  return ok({ content: body.content })
}

/**
 * Routine *definitions* are static client-side content and never touch this API —
 * only the record that a routine was completed is per-user data worth storing.
 */
async function completeCoreRoutine(event: ApiEvent) {
  const profile = await requireOwner(event)
  const routineId = pathParam(event, 'routineId')
  const body = parseBody(event, completionSchema)

  const item = {
    PK: userPk(profile.sub),
    SK: coreRoutineCompletionSk(routineId, body.date),
    ...envelope('CORE_ROUTINE_COMPLETION'),
    routineId,
    date: body.date,
  }

  await putItem(item)
  return created(item)
}

async function listCoreRoutineCompletions(event: ApiEvent) {
  const profile = await requireOwner(event)
  const items = await queryAll<{ routineId: string; date: string }>({
    pk: userPk(profile.sub),
    skPrefix: CORE_ROUTINE_COMPLETION_PREFIX,
  })
  return ok({ items })
}

/**
 * Curation of the shared default catalog.
 *
 * The catalog is read-only to every regular user — no `/exercises` path mutates it.
 * The owner authored it and remains its curator, so these narrow owner-gated routes
 * exist to maintain it. Edits here are visible to everyone, which is the intended
 * behaviour for a shared catalog and the reason they are not exposed more widely.
 */
const catalogUpdateSchema = z.object({
  // `name` is absent deliberately: it is the immutable id referenced by program
  // slots, sessions, and every history key. A rename changes displayName only.
  displayName: z.string().min(1).optional(),
  muscleGroups: z.array(z.string()).optional(),
  family: z.string().nullable().optional(),
  defaultRepRange: z.tuple([z.number(), z.number()]).nullable().optional(),
  defaultSets: z.number().int().positive().nullable().optional(),
  unilateral: z.boolean().optional(),
})

type CatalogItem = Exercise & ItemEnvelope & { PK: string; SK: string }

async function updateCatalogExercise(event: ApiEvent) {
  await requireOwner(event)
  const slug = pathParam(event, 'slug')
  const body = parseBody(event, catalogUpdateSchema)

  const existing = await getItem<CatalogItem>({
    PK: DEFAULT_LIBRARY_PK,
    SK: exerciseSk(slug),
  })
  if (!existing || existing.deleted) {
    throw ApiError.notFound(`No catalog exercise "${slug}"`)
  }

  const updated: CatalogItem = {
    ...existing,
    ...body,
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  }

  await putItem(updated)
  return ok(updated)
}

async function deleteCatalogExercise(event: ApiEvent) {
  await requireOwner(event)
  const slug = pathParam(event, 'slug')

  const existing = await getItem<CatalogItem>({
    PK: DEFAULT_LIBRARY_PK,
    SK: exerciseSk(slug),
  })
  if (!existing || existing.deleted) return noContent()

  // Soft-delete: program slots and history entries still reference this exercise,
  // and a hard delete would leave them unresolvable.
  await putItem({
    ...existing,
    deleted: true,
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
  })

  return noContent()
}

export const handler = withErrorHandling(
  router({
    'PATCH /owner/exercises/{slug}': updateCatalogExercise,
    'DELETE /owner/exercises/{slug}': deleteCatalogExercise,
    'GET /owner/531-config/{exercise}': get531Config,
    'PUT /owner/531-config/{exercise}': put531Config,
    'GET /owner/plan': getPlan,
    'PUT /owner/plan': putPlan,
    'POST /owner/core-routines/{routineId}/complete': completeCoreRoutine,
    'GET /owner/core-routines/completions': listCoreRoutineCompletions,
  }),
)
