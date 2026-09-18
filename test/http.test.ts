import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ApiError,
  intQueryParam,
  parseBody,
  pathParam,
  router,
  withErrorHandling,
  type ApiEvent,
} from '../src/shared/http'

const event = (overrides: Partial<ApiEvent> = {}) =>
  ({ routeKey: 'GET /me', ...overrides }) as unknown as ApiEvent

const bodyOf = (result: unknown) => JSON.parse((result as { body: string }).body)

describe('routing', () => {
  it('dispatches on the API Gateway route key', async () => {
    const handler = router({
      'GET /me': async () => ({ statusCode: 200, body: 'me' }),
      'PATCH /me': async () => ({ statusCode: 200, body: 'patched' }),
    })

    expect(await handler(event({ routeKey: 'PATCH /me' } as Partial<ApiEvent>)))
      .toMatchObject({ body: 'patched' })
  })

  it('404s an unmapped route rather than throwing something opaque', async () => {
    const handler = withErrorHandling(router({}))
    const result = await handler(event())

    expect(result).toMatchObject({ statusCode: 404 })
    expect(bodyOf(result).error.code).toBe('NOT_FOUND')
  })
})

describe('error handling', () => {
  it('renders ApiError with its status and code', async () => {
    const handler = withErrorHandling(async () => {
      throw ApiError.conflict('Session already exists')
    })

    const result = await handler(event())
    expect(result).toMatchObject({ statusCode: 409 })
    expect(bodyOf(result).error).toEqual({
      code: 'CONFLICT',
      message: 'Session already exists',
    })
  })

  it('turns a validation failure into a 400 naming the offending field', async () => {
    const handler = withErrorHandling(async (e) =>
      parseBody(e, z.object({ weight: z.number() })) as never,
    )

    const result = await handler(event({ body: JSON.stringify({ weight: 'heavy' }) }))
    expect(result).toMatchObject({ statusCode: 400 })
    expect(bodyOf(result).error.code).toBe('VALIDATION_FAILED')
    expect(bodyOf(result).error.details[0].path).toBe('weight')
  })

  /**
   * Optimistic-locking failures arrive wrapped when the write was transactional, so
   * both shapes must map to 409 rather than a confusing 500.
   */
  it('maps a bare conditional-check failure to 409', async () => {
    const handler = withErrorHandling(async () => {
      throw Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' })
    })
    expect(await handler(event())).toMatchObject({ statusCode: 409 })
  })

  it('maps a conditional failure wrapped in a cancelled transaction to 409', async () => {
    const handler = withErrorHandling(async () => {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      })
    })
    expect(await handler(event())).toMatchObject({ statusCode: 409 })
  })

  it('does not mistake an unrelated cancelled transaction for a conflict', async () => {
    const handler = withErrorHandling(async () => {
      throw Object.assign(new Error('throttled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ThrottlingError' }],
      })
    })
    expect(await handler(event())).toMatchObject({ statusCode: 500 })
  })

  it('hides internal detail behind a generic 500', async () => {
    const handler = withErrorHandling(async () => {
      throw new Error('connection string leaked here')
    })

    const result = await handler(event())
    expect(result).toMatchObject({ statusCode: 500 })
    expect(bodyOf(result).error.message).toBe('Internal server error')
  })
})

describe('request parsing', () => {
  it('rejects a missing body', () => {
    expect(() => parseBody(event(), z.object({}))).toThrow(ApiError)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseBody(event({ body: '{oops' }), z.object({}))).toThrow(ApiError)
  })

  it('decodes a base64-encoded body', () => {
    const parsed = parseBody(
      event({
        body: Buffer.from(JSON.stringify({ weight: 225 })).toString('base64'),
        isBase64Encoded: true,
      }),
      z.object({ weight: z.number() }),
    )
    expect(parsed.weight).toBe(225)
  })

  it('applies schema defaults', () => {
    const parsed = parseBody(event({ body: '{}' }), z.object({ tags: z.array(z.string()).default([]) }))
    expect(parsed.tags).toEqual([])
  })

  it('url-decodes path parameters so exercise names with spaces survive', () => {
    const e = event({ pathParameters: { slug: 'Hack%20Squat' } })
    expect(pathParam(e, 'slug')).toBe('Hack Squat')
  })

  it('rejects a missing path parameter', () => {
    expect(() => pathParam(event({ pathParameters: {} }), 'slug')).toThrow(ApiError)
  })

  it('falls back when a numeric query parameter is absent', () => {
    expect(intQueryParam(event(), 'limit', 20)).toBe(20)
  })

  it('rejects a non-positive or non-numeric limit', () => {
    expect(() => intQueryParam(event({ queryStringParameters: { limit: '0' } }), 'limit', 20)).toThrow()
    expect(() => intQueryParam(event({ queryStringParameters: { limit: 'ten' } }), 'limit', 20)).toThrow()
  })
})
