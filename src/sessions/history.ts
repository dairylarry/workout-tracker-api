import { envelope, type KeyRef } from '../shared/db'
import { exerciseHistorySk, userPk } from '../shared/keys'
import type { ExerciseHistoryEntry, ItemEnvelope, Session, SessionExercise } from '../shared/types'

/**
 * Derivation of exercise-history entries from a session.
 *
 * Kept free of I/O so the diffing rules — the subtlest logic in the API — can be
 * tested directly.
 */

export type HistoryItem = ExerciseHistoryEntry & ItemEnvelope & KeyRef

/**
 * The exercise actually performed. A swap logs history under the substitute, not the
 * programmed movement, which is what makes "show me every Hack Squat I've done" work.
 */
export const performedName = (exercise: SessionExercise): string =>
  exercise.swappedName ?? exercise.name

/**
 * An exercise earns a history entry only once something is logged against it.
 *
 * RIR alone doesn't count: 5/3/1 slots are pre-populated with target weights and
 * empty inputs, and those shouldn't manufacture history for a workout never performed.
 */
export const hasLoggedData = (exercise: SessionExercise): boolean =>
  exercise.sets.some((set) => set.weight !== null || set.reps !== null)

/**
 * History items are keyed by exercise slug first, so "every entry belonging to this
 * session" is not a queryable prefix. The session item therefore acts as its own
 * index: its exercise list deterministically reproduces the key set.
 *
 * `slotId` is part of the key so one exercise occupying two slots in a session — or
 * two supplemental entries of the same movement — cannot collide.
 */
export function historyItemsFor(
  sub: string,
  session: Session,
  now = new Date().toISOString(),
): HistoryItem[] {
  return session.exercises.filter(hasLoggedData).map((exercise) => {
    const slug = performedName(exercise)
    return {
      PK: userPk(sub),
      SK: exerciseHistorySk(slug, session.date, session.sessionType, exercise.slotId),
      ...envelope('EXERCISE_HISTORY', now),
      slug,
      date: session.date,
      sessionType: session.sessionType,
      slotId: exercise.slotId,
      sets: exercise.sets,
      weightUnit: exercise.weightUnit,
      ...(exercise.note ? { note: exercise.note } : {}),
    }
  })
}

/**
 * Entries the previous version of a session produced that the new one no longer does.
 *
 * This is what stops a swap from orphaning history: changing Leg Press to Hack Squat
 * leaves the leg-press entry in this set, to be deleted in the same transaction that
 * writes the hack-squat one.
 */
export function staleHistoryKeys(
  sub: string,
  previous: Session | undefined,
  next: Session,
): KeyRef[] {
  if (!previous) return []
  const nextKeys = new Set(historyItemsFor(sub, next).map((item) => item.SK))
  return historyItemsFor(sub, previous)
    .filter((item) => !nextKeys.has(item.SK))
    .map((item) => ({ PK: item.PK, SK: item.SK }))
}
