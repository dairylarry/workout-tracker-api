import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type { ItemEnvelope } from './types'

const client = new DynamoDBClient({})

export const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
})

export const TABLE = process.env.TABLE_NAME!

export const SCHEMA_VERSION = 1

/** Max items in a TransactWriteItems call — the ceiling behind the session-size cap. */
export const TRANSACT_ITEM_LIMIT = 100

export interface KeyRef {
  PK: string
  SK: string
}

export function envelope(entityType: string, now = new Date().toISOString()): ItemEnvelope {
  return {
    entityType,
    createdAt: now,
    updatedAt: now,
    version: 1,
    schemaVersion: SCHEMA_VERSION,
  }
}

export async function getItem<T>(key: KeyRef): Promise<T | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: key }))
  return res.Item as T | undefined
}

export async function putItem<T extends object>(item: T): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }))
}

export async function deleteItem(key: KeyRef): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: key }))
}

export async function transactWrite(
  items: NonNullable<TransactWriteCommandInput['TransactItems']>,
): Promise<void> {
  if (items.length === 0) return
  if (items.length > TRANSACT_ITEM_LIMIT) {
    throw new Error(
      `Transaction would contain ${items.length} items, exceeding the DynamoDB limit of ${TRANSACT_ITEM_LIMIT}`,
    )
  }
  await doc.send(new TransactWriteCommand({ TransactItems: items }))
}

export interface QueryOptions {
  pk: string
  skPrefix?: string
  limit?: number
  cursor?: string
  ascending?: boolean
  indexName?: string
}

export interface Page<T> {
  items: T[]
  cursor?: string
}

/** Cursor-based pagination; the cursor is an opaque wrapper around LastEvaluatedKey. */
export async function queryPage<T>(opts: QueryOptions): Promise<Page<T>> {
  const input: QueryCommandInput = {
    TableName: TABLE,
    KeyConditionExpression: opts.skPrefix
      ? '#pk = :pk AND begins_with(#sk, :skPrefix)'
      : '#pk = :pk',
    ExpressionAttributeNames: {
      '#pk': opts.indexName ? 'GSI1PK' : 'PK',
      ...(opts.skPrefix ? { '#sk': opts.indexName ? 'GSI1SK' : 'SK' } : {}),
    },
    ExpressionAttributeValues: {
      ':pk': opts.pk,
      ...(opts.skPrefix ? { ':skPrefix': opts.skPrefix } : {}),
    },
    ScanIndexForward: opts.ascending ?? false,
    ...(opts.indexName ? { IndexName: opts.indexName } : {}),
    ...(opts.limit ? { Limit: opts.limit } : {}),
    ...(opts.cursor ? { ExclusiveStartKey: decodeCursor(opts.cursor) } : {}),
  }

  const res = await doc.send(new QueryCommand(input))
  return {
    items: (res.Items ?? []) as T[],
    ...(res.LastEvaluatedKey ? { cursor: encodeCursor(res.LastEvaluatedKey) } : {}),
  }
}

/** Drains every page. Only for bounded result sets (a user's programs, tags, library). */
export async function queryAll<T>(opts: Omit<QueryOptions, 'cursor'>): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const page = await queryPage<T>({ ...opts, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  return items
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url')
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new BadCursorError()
  }
}

export class BadCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor')
  }
}

/**
 * Optimistic-locking and conditional-create failures surface either directly or
 * wrapped in a TransactionCanceledException, depending on whether the write was
 * transactional — callers need to treat both identically.
 */
export function isConditionalCheckFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: string }).name
  if (name === 'ConditionalCheckFailedException') return true
  if (name === 'TransactionCanceledException') {
    const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons
    return reasons?.some((r) => r.Code === 'ConditionalCheckFailed') ?? false
  }
  return false
}

export { UpdateCommand }
