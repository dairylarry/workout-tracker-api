import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProfileItem, computeFeatures, getCaller, isOwnerEmail } from '../src/shared/auth'
import { ApiError, type ApiEvent } from '../src/shared/http'
import { FEATURE_FLAGS, type Profile } from '../src/shared/types'

const eventWithClaims = (claims: Record<string, unknown> | undefined) =>
  ({ requestContext: { authorizer: claims ? { jwt: { claims } } : undefined } }) as unknown as ApiEvent

describe('caller identity', () => {
  it('identifies the caller by sub', () => {
    const caller = getCaller(eventWithClaims({ sub: 'abc-123', email: 'a@example.com' }))
    expect(caller).toEqual({ sub: 'abc-123', email: 'a@example.com' })
  })

  it('rejects a token with no subject claim', () => {
    expect(() => getCaller(eventWithClaims({ email: 'a@example.com' }))).toThrow(ApiError)
    expect(() => getCaller(eventWithClaims(undefined))).toThrow(ApiError)
  })

  /**
   * The access token has no email claim. Identity must still resolve from sub alone,
   * rather than throwing and breaking every request.
   */
  it('tolerates a missing email claim', () => {
    expect(getCaller(eventWithClaims({ sub: 'abc-123' })).email).toBe('')
  })
})

describe('owner determination', () => {
  const original = process.env.OWNER_EMAIL

  beforeEach(() => {
    process.env.OWNER_EMAIL = 'owner@example.com'
  })

  afterEach(() => {
    if (original === undefined) delete process.env.OWNER_EMAIL
    else process.env.OWNER_EMAIL = original
  })

  it('matches the configured owner email', () => {
    expect(isOwnerEmail('owner@example.com')).toBe(true)
  })

  it('ignores case and surrounding whitespace', () => {
    expect(isOwnerEmail('  Owner@Example.COM ')).toBe(true)
  })

  it('rejects everyone else', () => {
    expect(isOwnerEmail('someone@example.com')).toBe(false)
  })

  it('never grants ownership on an empty email', () => {
    expect(isOwnerEmail('')).toBe(false)
  })

  it('grants nobody ownership when OWNER_EMAIL is unset', () => {
    delete process.env.OWNER_EMAIL
    expect(isOwnerEmail('owner@example.com')).toBe(false)
  })

  it('stamps isOwner onto a newly built profile', () => {
    expect(buildProfileItem('sub-1', 'owner@example.com').isOwner).toBe(true)
    expect(buildProfileItem('sub-2', 'other@example.com').isOwner).toBe(false)
  })

  it('defaults a new profile to lbs, matching the legacy app', () => {
    expect(buildProfileItem('sub-1', 'a@example.com').defaultWeightUnit).toBe('lbs')
  })
})

describe('feature flags', () => {
  const profile = (overrides: Partial<Profile> = {}): Profile => ({
    sub: 'sub-1',
    email: 'a@example.com',
    defaultWeightUnit: 'lbs',
    isOwner: false,
    ...overrides,
  })

  it('turns every owner-only feature off for a normal user', () => {
    const features = computeFeatures(profile())
    expect(Object.values(features).every((v) => v === false)).toBe(true)
  })

  it('turns them on for the owner', () => {
    const features = computeFeatures(profile({ isOwner: true }))
    expect(Object.values(features).every((v) => v === true)).toBe(true)
  })

  it('returns every declared flag so clients never see undefined', () => {
    const features = computeFeatures(profile())
    for (const flag of FEATURE_FLAGS) {
      expect(features).toHaveProperty(flag)
    }
  })

  it('lets a per-user override win over the default', () => {
    const features = computeFeatures(profile({ featureOverrides: { intervalTimer: true } }))
    expect(features.intervalTimer).toBe(true)
    expect(features.planDoc).toBe(false)
  })

  it('lets an override revoke a feature from the owner', () => {
    const features = computeFeatures(
      profile({ isOwner: true, featureOverrides: { planDoc: false } }),
    )
    expect(features.planDoc).toBe(false)
    expect(features.fiveThreeOne).toBe(true)
  })
})
