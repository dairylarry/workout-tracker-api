import { z } from 'zod'
import { getCaller } from '../shared/auth'
import { deleteItem, envelope, getItem, putItem, queryPage } from '../shared/db'
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
import { BODYWEIGHT_PREFIX, bodyweightSk, tagsSk, userPk } from '../shared/keys'
import type { BodyweightEntry, ItemEnvelope, Tag, TimeOfDay } from '../shared/types'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const bodyweightSchema = z.object({
  date: z.string().regex(DATE_PATTERN, 'Date must be formatted YYYY-MM-DD'),
  timeOfDay: z.enum(['morning', 'afternoon', 'night']),
  weight: z.number().positive(),
  weightUnit: z.enum(['lbs', 'kg']),
})

const tagsSchema = z.object({
  tags: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      color: z.object({ bg: z.string(), text: z.string() }),
      deleted: z.boolean().optional(),
    }),
  ),
})

async function listBodyweight(event: ApiEvent) {
  const { sub } = getCaller(event)
  const page = await queryPage<BodyweightEntry & ItemEnvelope>({
    pk: userPk(sub),
    skPrefix: BODYWEIGHT_PREFIX,
    limit: intQueryParam(event, 'limit', 60),
    ...(queryParam(event, 'cursor') ? { cursor: queryParam(event, 'cursor')! } : {}),
  })
  return ok(page)
}

/**
 * Keyed by date *and* time of day, so morning and night weigh-ins coexist. Re-logging
 * the same slot overwrites — bodyweight doesn't meaningfully move within a slot.
 */
async function putBodyweight(event: ApiEvent) {
  const { sub } = getCaller(event)
  const body = parseBody(event, bodyweightSchema)

  const item = {
    PK: userPk(sub),
    SK: bodyweightSk(body.date, body.timeOfDay),
    ...envelope('BODYWEIGHT'),
    date: body.date,
    timeOfDay: body.timeOfDay,
    weight: body.weight,
    weightUnit: body.weightUnit,
  }

  await putItem(item)
  return created(item)
}

async function deleteBodyweight(event: ApiEvent) {
  const { sub } = getCaller(event)
  const date = pathParam(event, 'date')
  if (!DATE_PATTERN.test(date)) {
    throw ApiError.badRequest('Date must be formatted YYYY-MM-DD')
  }

  const timeOfDay = pathParam(event, 'timeOfDay')
  if (!['morning', 'afternoon', 'night'].includes(timeOfDay)) {
    throw ApiError.badRequest('timeOfDay must be one of: morning, afternoon, night')
  }

  await deleteItem({ PK: userPk(sub), SK: bodyweightSk(date, timeOfDay as TimeOfDay) })
  return noContent()
}

async function getTags(event: ApiEvent) {
  const { sub } = getCaller(event)
  const item = await getItem<{ tags: Tag[] } & ItemEnvelope>({
    PK: userPk(sub),
    SK: tagsSk(),
  })
  return ok({ tags: item?.tags ?? [] })
}

/** Tags are a single document; soft-deleted entries stay so past sessions still resolve them. */
async function putTags(event: ApiEvent) {
  const { sub } = getCaller(event)
  const body = parseBody(event, tagsSchema)

  const existing = await getItem<ItemEnvelope>({ PK: userPk(sub), SK: tagsSk() })

  const item = {
    PK: userPk(sub),
    SK: tagsSk(),
    ...(existing ?? envelope('TAGS')),
    tags: body.tags,
    updatedAt: new Date().toISOString(),
    version: (existing?.version ?? 0) + 1,
  }

  await putItem(item)
  return ok({ tags: body.tags })
}

export const handler = withErrorHandling(
  router({
    'GET /bodyweight': listBodyweight,
    'POST /bodyweight': putBodyweight,
    'DELETE /bodyweight/{date}/{timeOfDay}': deleteBodyweight,
    'GET /tags': getTags,
    'PUT /tags': putTags,
  }),
)
