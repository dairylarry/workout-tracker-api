import type { PostConfirmationTriggerHandler } from 'aws-lambda'
import { ensureProfile } from '../shared/auth'

/**
 * Creates USER#<sub>/PROFILE on signup.
 *
 * This is best-effort by design: the same idempotent `ensureProfile` runs lazily on
 * GET /me, so a failure here degrades to a profile created on first API call rather
 * than a broken account. The trigger must still return the event unmodified —
 * throwing would fail the user's sign-up for a non-critical write.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const sub = event.request.userAttributes['sub']
  const email = event.request.userAttributes['email'] ?? ''

  if (!sub) {
    console.error('Post-confirmation trigger fired without a sub attribute')
    return event
  }

  try {
    await ensureProfile(sub, email)
  } catch (err) {
    console.error('Failed to create profile on post-confirmation; GET /me will retry', err)
  }

  return event
}
