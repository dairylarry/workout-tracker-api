/**
 * Every DynamoDB key in the system is built here.
 *
 * Keys are the easiest thing to get subtly wrong and the hardest to fix once data
 * exists, so nothing else in the codebase constructs a PK or SK by hand.
 */

import { TIME_OF_DAY_ORDINAL, type TimeOfDay } from './types'

export const PROGRAM_VERSION_PAD = 5

export const userPk = (sub: string) => `USER#${sub}`

export const profileSk = () => 'PROFILE'

// -- Exercises ---------------------------------------------------------------

/** Global read-only catalog; not namespaced to any user. */
export const DEFAULT_LIBRARY_PK = 'EXERCISE_LIB_DEFAULT'

export const exerciseSk = (slug: string) => `EXERCISE#${slug}`

// -- Exercise history --------------------------------------------------------

/**
 * One item per logged entry — unbounded, unlike the legacy 20-entry capped array.
 *
 * `slotId` is part of the key so the same exercise appearing in two slots of one
 * session cannot collide. Supplemental exercises carry a generated `supp-<ulid>`
 * slotId for exactly this reason.
 */
export const exerciseHistorySk = (
  slug: string,
  date: string,
  sessionType: string,
  slotId: string,
) => `EXERCISE_HISTORY#${slug}#${date}#${sessionType}#${slotId}`

export const exerciseHistoryPrefix = (slug: string) => `EXERCISE_HISTORY#${slug}#`

// -- Programs ----------------------------------------------------------------

export const programSk = (id: string) => `SESSION_TYPE#${id}`

export const PROGRAM_PREFIX = 'SESSION_TYPE#'

/**
 * Archived program versions live under a distinct prefix rather than a suffix on
 * the program key: `begins_with(SK, 'SESSION_TYPE#')` must return current programs
 * only, and relying on `SESSION_TYPE_VERSION#` not matching that prefix would be
 * too subtle to trust.
 */
export const programVersionSk = (id: string, version: number) =>
  `PROGRAM_VERSION#${id}#${String(version).padStart(PROGRAM_VERSION_PAD, '0')}`

// -- Sessions ----------------------------------------------------------------

export const sessionPk = (sub: string, sessionType: string) =>
  `USER#${sub}#SESSION#${sessionType}`

export const sessionSk = (date: string) => `DATE#${date}`

// -- Bodyweight --------------------------------------------------------------

/** Ordinal precedes the label so morning/afternoon/night sort chronologically. */
export const bodyweightSk = (date: string, timeOfDay: TimeOfDay) =>
  `BODYWEIGHT#DATE#${date}#${TIME_OF_DAY_ORDINAL[timeOfDay]}#${timeOfDay}`

export const BODYWEIGHT_PREFIX = 'BODYWEIGHT#DATE#'

// -- Tags --------------------------------------------------------------------

export const tagsSk = () => 'TAGS'

// -- Owner-only --------------------------------------------------------------

export const fiveThreeOneConfigSk = (exercise: string) => `531_CONFIG#EXERCISE#${exercise}`

export const planDocSk = () => 'PLAN_DOC'

export const coreRoutineCompletionSk = (routineId: string, date: string) =>
  `CORE_ROUTINE_COMPLETION#${routineId}#${date}`

export const CORE_ROUTINE_COMPLETION_PREFIX = 'CORE_ROUTINE_COMPLETION#'

export const coreRoutineArchiveSk = (routineId: string) => `CORE_ROUTINE_ARCHIVE#${routineId}`

// -- GSI1 --------------------------------------------------------------------

/**
 * Generic index attributes. A GSI's key schema can never be altered after creation,
 * so these stay opaque — any entity type can opt in later without a new index.
 */
export const gsi1SessionKeys = (sub: string, date: string) => ({
  GSI1PK: userPk(sub),
  GSI1SK: `DATE#${date}`,
})
