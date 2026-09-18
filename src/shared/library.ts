import { queryAll } from './db'
import { DEFAULT_LIBRARY_PK, userPk } from './keys'
import type { Exercise, ItemEnvelope, ProgramSub } from './types'

export type LibraryItem = Exercise & ItemEnvelope & { PK: string; SK: string }

/**
 * A user's effective library: the shared golden catalog plus their own additions.
 *
 * Soft-deleted entries are excluded from what a user can newly reference, but their
 * definitions remain in the table so existing program slots and history still resolve.
 */
export async function loadEffectiveLibrary(sub: string): Promise<LibraryItem[]> {
  const [defaults, custom] = await Promise.all([
    queryAll<LibraryItem>({ pk: DEFAULT_LIBRARY_PK, ascending: true }),
    queryAll<LibraryItem>({ pk: userPk(sub), skPrefix: 'EXERCISE#', ascending: true }),
  ])

  return [...defaults, ...custom].filter((exercise) => !exercise.deleted)
}

export const subName = (sub: ProgramSub): string => (typeof sub === 'string' ? sub : sub.name)

/**
 * Every exercise a program references — primary movements and substitutions alike —
 * must exist in the library, or a session started from it would fail to resolve the
 * slot. The legacy data has perfect referential integrity; this keeps it that way.
 */
export function findUnknownExercises(
  exercises: Array<{ name: string; subs?: ProgramSub[] }>,
  known: Set<string>,
): string[] {
  const referenced = new Set<string>()

  for (const exercise of exercises) {
    referenced.add(exercise.name)
    for (const sub of exercise.subs ?? []) {
      referenced.add(subName(sub))
    }
  }

  return [...referenced].filter((name) => !known.has(name)).sort()
}
