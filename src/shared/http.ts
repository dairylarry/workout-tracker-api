import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda'
import { z } from 'zod'
import { BadCursorError, isConditionalCheckFailure } from './db'

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }

  static badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message)
  static forbidden = (message = 'Forbidden') => new ApiError(403, 'FORBIDDEN', message)
  static notFound = (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message)
  static conflict = (message: string) => new ApiError(409, 'CONFLICT', message)
}

export function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const ok = (body: unknown) => json(200, body)
export const created = (body: unknown) => json(201, body)
export const noContent = (): APIGatewayProxyResultV2 => ({ statusCode: 204, body: '' })

export type RouteHandler = (event: ApiEvent) => Promise<APIGatewayProxyResultV2>

/**
 * Dispatches on API Gateway's own `routeKey` (e.g. "GET /exercises/{slug}"), so the
 * route table here stays identical to the one declared in the CDK construct.
 */
export function router(routes: Record<string, RouteHandler>): RouteHandler {
  return async (event) => {
    const handler = routes[event.routeKey]
    if (!handler) {
      throw ApiError.notFound(`No route for ${event.routeKey}`)
    }
    return handler(event)
  }
}

export function withErrorHandling(handler: RouteHandler): RouteHandler {
  return async (event) => {
    try {
      return await handler(event)
    } catch (err) {
      return toErrorResponse(err)
    }
  }
}

function toErrorResponse(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof ApiError) {
    return json(err.status, { error: { code: err.code, message: err.message } })
  }
  if (err instanceof BadCursorError) {
    return json(400, { error: { code: 'BAD_CURSOR', message: err.message } })
  }
  if (err instanceof z.ZodError) {
    return json(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request body failed validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    })
  }
  if (isConditionalCheckFailure(err)) {
    return json(409, {
      error: {
        code: 'CONFLICT',
        message: 'The item was modified by another request. Reload and retry.',
      },
    })
  }

  console.error('Unhandled error', err)
  return json(500, { error: { code: 'INTERNAL', message: 'Internal server error' } })
}

export function parseBody<S extends z.ZodTypeAny>(event: ApiEvent, schema: S): z.output<S> {
  if (!event.body) throw ApiError.badRequest('Request body is required')
  let raw: unknown
  try {
    raw = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body)
  } catch {
    throw ApiError.badRequest('Request body is not valid JSON')
  }
  return schema.parse(raw)
}

export function pathParam(event: ApiEvent, name: string): string {
  const value = event.pathParameters?.[name]
  if (!value) throw ApiError.badRequest(`Missing path parameter "${name}"`)
  return decodeURIComponent(value)
}

export function queryParam(event: ApiEvent, name: string): string | undefined {
  return event.queryStringParameters?.[name]
}

export function intQueryParam(event: ApiEvent, name: string, fallback: number): number {
  const raw = queryParam(event, name)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    throw ApiError.badRequest(`Query parameter "${name}" must be a positive integer`)
  }
  return parsed
}
