import { envelope, getItem, putItem } from './db'
import { ApiError, type ApiEvent } from './http'
import { profileSk, userPk } from './keys'
import {
  FEATURE_FLAGS,
  type FeatureMap,
  type ItemEnvelope,
  type Profile,
  type WeightUnit,
} from './types'

export interface Caller {
  sub: string
  email: string
}

export type ProfileItem = Profile & ItemEnvelope & { PK: string; SK: string }

/**
 * Identity comes from the `sub` claim, never email — email is mutable and would
 * orphan every key that referenced it.
 */
export function getCaller(event: ApiEvent): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims
  const sub = claims?.['sub']
  const email = claims?.['email']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Missing subject claim')
  }
  return { sub, email: typeof email === 'string' ? email : '' }
}

const DEFAULT_WEIGHT_UNIT: WeightUnit = 'lbs'

export function isOwnerEmail(email: string): boolean {
  const ownerEmail = process.env.OWNER_EMAIL
  if (!ownerEmail || !email) return false
  return email.trim().toLowerCase() === ownerEmail.trim().toLowerCase()
}

export function buildProfileItem(sub: string, email: string): ProfileItem {
  return {
    PK: userPk(sub),
    SK: profileSk(),
    ...envelope('PROFILE'),
    sub,
    email,
    defaultWeightUnit: DEFAULT_WEIGHT_UNIT,
    isOwner: isOwnerEmail(email),
  }
}

/**
 * Idempotent profile creation, shared by the Cognito post-confirmation trigger and
 * by GET /me.
 *
 * Cognito triggers fail with no retry — a confirmed user whose trigger failed would
 * otherwise have no profile and every subsequent request would break. Reading first
 * keeps an existing profile (and any preference edits) intact.
 */
export async function ensureProfile(sub: string, email: string): Promise<ProfileItem> {
  const existing = await getItem<ProfileItem>({ PK: userPk(sub), SK: profileSk() })
  if (existing) return existing

  const profile = buildProfileItem(sub, email)
  await putItem(profile)
  return profile
}

export async function requireProfile(event: ApiEvent): Promise<ProfileItem> {
  const caller = getCaller(event)
  return ensureProfile(caller.sub, caller.email)
}

/** Owner-only endpoints check this directly — never a feature flag, which is UI gating only. */
export async function requireOwner(event: ApiEvent): Promise<ProfileItem> {
  const profile = await requireProfile(event)
  if (!profile.isOwner) {
    throw ApiError.forbidden('This resource is restricted to the account owner')
  }
  return profile
}

/**
 * Effective flags are computed server-side so clients never derive gating logic.
 * Precedence is code defaults → per-user overrides; a global CONFIG item slots in
 * between these when no-deploy flipping is actually needed.
 */
export function computeFeatures(profile: Profile): FeatureMap {
  const defaults = Object.fromEntries(
    FEATURE_FLAGS.map((flag) => [flag, profile.isOwner]),
  ) as FeatureMap

  return { ...defaults, ...profile.featureOverrides }
}
