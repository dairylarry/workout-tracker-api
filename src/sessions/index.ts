import { z } from 'zod'
import { getCaller } from '../shared/auth'
import {
  TABLE,
  envelope,
  getItem,
  isConditionalCheckFailure,
  queryPage,
  transactWrite,
} from '../shared/db'
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
import { gsi1SessionKeys, programSk, sessionPk, sessionSk, userPk } from '../shared/keys'
import type { ItemEnvelope, Session } from '../shared/types'
import { historyItemsFor, staleHistoryKeys } from './history'

/**
 * A save writes 1 session item + N history puts + up to N history deletes, and
 * DynamoDB caps a transaction at 100 items. 40 keeps the worst case (1 + 40 + 40)
 * comfortably inside that, and is >4x the largest session ever logged.
 */
const MAX_EXERCISES_PER_SESSION = 40

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MONTH_PATTERN = /^\d{4}-\d{2}$/

type SessionItem = Session & ItemEnvelope & { PK: string; SK: string }

const setSchema = z.object({
  setNumber: z.number().int().positive(),
  weight: z.number().nullable(),
  reps: z.number().nullable(),
  rir: z.number().nullable(),
  isWarmup: z.boolean().optional(),
  label: z.string().optional(),
  target: z.number().nullable().optional(),
})

const exerciseSchema = z.object({
  slotId: z.string().min(1),
  name: z.string().min(1),
  swappedName: z.string().min(1).optional(),
  supplemental: z.boolean().optional(),
  weightUnit: z.enum(['lbs', 'kg']),
  note: z.string().optional(),
  sets: z.array(setSchema),
  is531: z.boolean().optional(),
  week: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('deload')]).optional(),
  trainingMax: z.number().optional(),
})

const sessionSchema = z.object({
  startedAt: z.string().datetime(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  fiveDay: z.boolean().optional(),
  exercises: z
    .array(exerciseSchema)
    .max(
      MAX_EXERCISES_PER_SESSION,
      `A session may contain at most ${MAX_EXERCISES_PER_SESSION} exercises`,
    ),
})

function assertDate(date: string): string {
  if (!DATE_PATTERN.test(date)) {
    throw ApiError.badRequest('Date must be formatted YYYY-MM-DD')
  }
  return date
}

async function currentProgramVersion(sub: string, sessionType: string): Promise<number> {
  const program = await getItem<{ version: number }>({
    PK: userPk(sub),
    SK: programSk(sessionType),
  })
  return program?.version ?? 1
}

async function readSession(sub: string, type: string, date: string) {
  return getItem<SessionItem>({ PK: sessionPk(sub, type), SK: sessionSk(date) })
}

/**
 * Writes the session and reconciles its derived history entries in one transaction.
 *
 * Diffing against the previous exercise list is what makes swaps clean: changing
 * Leg Press to Hack Squat deletes the leg-press history item rather than orphaning it.
 */
async function saveSession(
  sub: string,
  next: SessionItem,
  previous: SessionItem | undefined,
  condition: 'create' | 'update',
) {
  const nextHistory = historyItemsFor(sub, next)
  const staleKeys = staleHistoryKeys(sub, previous, next)

  await transactWrite([
    {
      Put: {
        TableName: TABLE,
        Item: next,
        ...(condition === 'create'
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              // `version` is a DynamoDB reserved word, hence the alias.
              ConditionExpression: '#v = :expectedVersion',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': previous?.version ?? 1 },
            }),
      },
    },
    ...nextHistory.map((item) => ({ Put: { TableName: TABLE, Item: item } })),
    ...staleKeys.map((key) => ({ Delete: { TableName: TABLE, Key: key } })),
  ])
}

async function listSessions(event: ApiEvent) {
  const { sub } = getCaller(event)
  const type = queryParam(event, 'type')
  if (!type) throw ApiError.badRequest('Query parameter "type" is required')

  const page = await queryPage<SessionItem>({
    pk: sessionPk(sub, type),
    limit: intQueryParam(event, 'limit', 20),
    ...(queryParam(event, 'cursor') ? { cursor: queryParam(event, 'cursor')! } : {}),
  })

  return ok(page)
}

/** Cross-type date lookup for the calendar view, served by GSI1. */
async function listCalendar(event: ApiEvent) {
  const { sub } = getCaller(event)
  const month = queryParam(event, 'month')
  if (!month || !MONTH_PATTERN.test(month)) {
    throw ApiError.badRequest('Query parameter "month" is required, formatted YYYY-MM')
  }

  const page = await queryPage<SessionItem>({
    pk: userPk(sub),
    skPrefix: `DATE#${month}`,
    indexName: 'GSI1',
    ascending: true,
  })

  return ok(page)
}

async function getSession(event: ApiEvent) {
  const { sub } = getCaller(event)
  const session = await readSession(
    sub,
    pathParam(event, 'type'),
    assertDate(pathParam(event, 'date')),
  )
  if (!session) throw ApiError.notFound('No session logged for that type and date')
  return ok(session)
}

async function createSession(event: ApiEvent) {
  const { sub } = getCaller(event)
  const type = pathParam(event, 'type')
  const date = assertDate(pathParam(event, 'date'))
  const body = parseBody(event, sessionSchema)

  const session: SessionItem = {
    PK: sessionPk(sub, type),
    SK: sessionSk(date),
    ...gsi1SessionKeys(sub, date),
    ...envelope('SESSION'),
    sessionType: type,
    date,
    startedAt: body.startedAt,
    programVersion: await currentProgramVersion(sub, type),
    tags: body.tags,
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.fiveDay !== undefined ? { fiveDay: body.fiveDay } : {}),
    exercises: body.exercises,
  }

  try {
    await saveSession(sub, session, undefined, 'create')
  } catch (err) {
    // A conditional failure here means a session already exists — surfacing it as a
    // conflict lets the client offer "open the existing session?" instead of
    // silently overwriting a real workout.
    if (isConditionalCheckFailure(err)) {
      throw ApiError.conflict(
        'A session already exists for this type and date. Open it instead of creating a new one.',
      )
    }
    throw err
  }

  return created(session)
}

async function updateSession(event: ApiEvent) {
  const { sub } = getCaller(event)
  const type = pathParam(event, 'type')
  const date = assertDate(pathParam(event, 'date'))
  const body = parseBody(event, sessionSchema)

  const previous = await readSession(sub, type, date)
  if (!previous) throw ApiError.notFound('No session logged for that type and date')

  const session: SessionItem = {
    ...previous,
    ...gsi1SessionKeys(sub, date),
    startedAt: body.startedAt,
    tags: body.tags,
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.fiveDay !== undefined ? { fiveDay: body.fiveDay } : {}),
    exercises: body.exercises,
    updatedAt: new Date().toISOString(),
    version: previous.version + 1,
  }

  await saveSession(sub, session, previous, 'update')
  return ok(session)
}

/** Deleting a session must take its derived history with it, or the entries orphan. */
async function deleteSession(event: ApiEvent) {
  const { sub } = getCaller(event)
  const type = pathParam(event, 'type')
  const date = assertDate(pathParam(event, 'date'))

  const existing = await readSession(sub, type, date)
  if (!existing) return noContent()

  await transactWrite([
    { Delete: { TableName: TABLE, Key: { PK: existing.PK, SK: existing.SK } } },
    ...historyItemsFor(sub, existing).map((item) => ({
      Delete: { TableName: TABLE, Key: { PK: item.PK, SK: item.SK } },
    })),
  ])

  return noContent()
}

export const handler = withErrorHandling(
  router({
    'GET /sessions': listSessions,
    'GET /sessions/calendar': listCalendar,
    'GET /sessions/{type}/{date}': getSession,
    'POST /sessions/{type}/{date}': createSession,
    'PUT /sessions/{type}/{date}': updateSession,
    'DELETE /sessions/{type}/{date}': deleteSession,
  }),
)
