import { z } from 'zod'
import { computeFeatures, getCaller, requireProfile, type ProfileItem } from '../shared/auth'
import { deleteItem, putItem, queryAll } from '../shared/db'
import {
  ok,
  noContent,
  parseBody,
  router,
  withErrorHandling,
  type ApiEvent,
} from '../shared/http'
import { PROGRAM_PREFIX, sessionPk, userPk } from '../shared/keys'

const patchSchema = z.object({
  defaultWeightUnit: z.enum(['lbs', 'kg']).optional(),
})

function toResponse(profile: ProfileItem) {
  return {
    sub: profile.sub,
    email: profile.email,
    defaultWeightUnit: profile.defaultWeightUnit,
    isOwner: profile.isOwner,
    features: computeFeatures(profile),
  }
}

async function getMe(event: ApiEvent) {
  return ok(toResponse(await requireProfile(event)))
}

async function patchMe(event: ApiEvent) {
  const profile = await requireProfile(event)
  const body = parseBody(event, patchSchema)

  const updated: ProfileItem = {
    ...profile,
    ...(body.defaultWeightUnit ? { defaultWeightUnit: body.defaultWeightUnit } : {}),
    updatedAt: new Date().toISOString(),
    version: profile.version + 1,
  }

  await putItem(updated)
  return ok(toResponse(updated))
}

/**
 * Deletes the account's data.
 *
 * Sessions live in their own partition per session type (PK USER#<sub>#SESSION#<type>),
 * so they cannot be removed by clearing one prefix — the program list is enumerated
 * first to discover which partitions exist.
 */
async function deleteMe(event: ApiEvent) {
  const { sub } = getCaller(event)

  const programs = await queryAll<{ id: string }>({
    pk: userPk(sub),
    skPrefix: PROGRAM_PREFIX,
  })

  const keys = await queryAll<{ PK: string; SK: string }>({ pk: userPk(sub) })

  for (const program of programs) {
    const sessionKeys = await queryAll<{ PK: string; SK: string }>({
      pk: sessionPk(sub, program.id),
    })
    keys.push(...sessionKeys)
  }

  for (const key of keys) {
    await deleteItem({ PK: key.PK, SK: key.SK })
  }

  return noContent()
}

export const handler = withErrorHandling(
  router({
    'GET /me': getMe,
    'PATCH /me': patchMe,
    'DELETE /me': deleteMe,
  }),
)
