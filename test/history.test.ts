import { describe, expect, it } from 'vitest'
import { historyItemsFor, staleHistoryKeys } from '../src/sessions/history'
import type { Session, SessionExercise } from '../src/shared/types'

const SUB = 'user-123'

const exercise = (overrides: Partial<SessionExercise> = {}): SessionExercise => ({
  slotId: 'la-legpress',
  name: 'Leg Press',
  weightUnit: 'lbs',
  sets: [{ setNumber: 1, weight: 305, reps: 12, rir: 2 }],
  ...overrides,
})

const session = (exercises: SessionExercise[]): Session => ({
  sessionType: 'lower-a',
  date: '2026-08-24',
  startedAt: '2026-08-24T18:00:00.000Z',
  programVersion: 1,
  tags: [],
  exercises,
})

describe('history key derivation', () => {
  it('keys on the performed exercise, not the programmed one', () => {
    const [item] = historyItemsFor(SUB, session([
      exercise({ name: 'Leg Press', swappedName: 'Hack Squat' }),
    ]))

    expect(item!.slug).toBe('Hack Squat')
    expect(item!.SK).toBe('EXERCISE_HISTORY#Hack Squat#2026-08-24#lower-a#la-legpress')
  })

  it('includes slotId so one exercise in two slots does not collide', () => {
    const items = historyItemsFor(SUB, session([
      exercise({ slotId: 'ua-fly', name: 'Incline Cable Fly' }),
      exercise({ slotId: 'ub-fly', name: 'Incline Cable Fly' }),
    ]))

    expect(new Set(items.map((i) => i.SK)).size).toBe(2)
  })

  it('distinguishes two supplemental entries of the same exercise', () => {
    const items = historyItemsFor(SUB, session([
      exercise({ slotId: 'supp-01', name: 'Cable Crunch', supplemental: true }),
      exercise({ slotId: 'supp-02', name: 'Cable Crunch', supplemental: true }),
    ]))

    expect(new Set(items.map((i) => i.SK)).size).toBe(2)
  })

  it('skips exercises with nothing logged', () => {
    const items = historyItemsFor(SUB, session([
      exercise({ sets: [{ setNumber: 1, weight: null, reps: null, rir: null }] }),
      exercise({ slotId: 'la-rdl', name: 'Romanian Deadlift', sets: [] }),
    ]))

    expect(items).toHaveLength(0)
  })

  it('keeps a 5/3/1 slot whose target is set but which was never performed out of history', () => {
    const items = historyItemsFor(SUB, session([
      exercise({
        slotId: 'la-squat',
        name: 'Barbell Back Squat',
        is531: true,
        week: 1,
        trainingMax: 335,
        sets: [
          { setNumber: 1, weight: null, reps: null, rir: null, isWarmup: true, label: 'Warmup 1×5', target: 135 },
          { setNumber: 2, weight: null, reps: null, rir: null, isWarmup: false, label: '1×5', target: 245 },
        ],
      }),
    ]))

    expect(items).toHaveLength(0)
  })

  it('carries the per-exercise note onto the entry', () => {
    const [item] = historyItemsFor(SUB, session([exercise({ note: 'Start at 225 next time' })]))
    expect(item!.note).toBe('Start at 225 next time')
  })
})

describe('stale key diffing', () => {
  it('returns nothing when there is no previous session', () => {
    expect(staleHistoryKeys(SUB, undefined, session([exercise()]))).toEqual([])
  })

  it('marks the old slug for deletion when an exercise is swapped', () => {
    const before = session([exercise({ name: 'Leg Press' })])
    const after = session([exercise({ name: 'Leg Press', swappedName: 'Hack Squat' })])

    const stale = staleHistoryKeys(SUB, before, after)

    expect(stale).toHaveLength(1)
    expect(stale[0]!.SK).toContain('#Leg Press#')
  })

  it('marks an entry for deletion when its sets are cleared', () => {
    const before = session([exercise()])
    const after = session([
      exercise({ sets: [{ setNumber: 1, weight: null, reps: null, rir: null }] }),
    ])

    expect(staleHistoryKeys(SUB, before, after)).toHaveLength(1)
  })

  it('marks an entry for deletion when the exercise is removed entirely', () => {
    const before = session([exercise(), exercise({ slotId: 'la-rdl', name: 'Romanian Deadlift' })])
    const after = session([exercise()])

    const stale = staleHistoryKeys(SUB, before, after)

    expect(stale).toHaveLength(1)
    expect(stale[0]!.SK).toContain('#Romanian Deadlift#')
  })

  it('leaves an unchanged exercise alone when only its weights are edited', () => {
    const before = session([exercise()])
    const after = session([
      exercise({ sets: [{ setNumber: 1, weight: 325, reps: 12, rir: 2 }] }),
    ])

    // Same key, so the entry is overwritten in place rather than deleted and re-added.
    expect(staleHistoryKeys(SUB, before, after)).toEqual([])
  })

  it('does not delete anything when exercises are merely reordered', () => {
    const a = exercise({ slotId: 'la-legpress', name: 'Leg Press' })
    const b = exercise({ slotId: 'la-rdl', name: 'Romanian Deadlift' })

    expect(staleHistoryKeys(SUB, session([a, b]), session([b, a]))).toEqual([])
  })
})
