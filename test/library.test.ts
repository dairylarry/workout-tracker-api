import { describe, expect, it } from 'vitest'
import { findUnknownExercises, subName } from '../src/shared/library'
import type { ProgramSub } from '../src/shared/types'

const known = new Set(['Leg Press', 'Hack Squat', 'Goblet Squat', 'Romanian Deadlift'])

describe('substitute names', () => {
  it('reads a plain string substitute', () => {
    expect(subName('Hack Squat')).toBe('Hack Squat')
  })

  /** Substitutes are heterogeneous in the real data — some carry programming overrides. */
  it('reads a substitute carrying overrides', () => {
    const sub: ProgramSub = { name: 'Bulgarian Split Squat', sets: 2, repRange: [8, 8], perSide: true }
    expect(subName(sub)).toBe('Bulgarian Split Squat')
  })
})

describe('program exercise validation', () => {
  it('accepts a program whose exercises all exist', () => {
    const unknown = findUnknownExercises(
      [{ name: 'Leg Press', subs: ['Hack Squat', 'Goblet Squat'] }],
      known,
    )
    expect(unknown).toEqual([])
  })

  it('catches a typo in a primary exercise', () => {
    const unknown = findUnknownExercises([{ name: 'Leg Pres' }], known)
    expect(unknown).toEqual(['Leg Pres'])
  })

  /** A bad substitute only surfaces when someone swaps mid-workout — too late to be useful. */
  it('catches a typo in a substitute', () => {
    const unknown = findUnknownExercises(
      [{ name: 'Leg Press', subs: ['Hack Squatt'] }],
      known,
    )
    expect(unknown).toEqual(['Hack Squatt'])
  })

  it('catches a typo in an override-style substitute', () => {
    const unknown = findUnknownExercises(
      [{ name: 'Leg Press', subs: [{ name: 'Nordic Curl', sets: 2 }] }],
      known,
    )
    expect(unknown).toEqual(['Nordic Curl'])
  })

  it('reports each unknown name once, sorted, however often it appears', () => {
    const unknown = findUnknownExercises(
      [
        { name: 'Zercher Squat', subs: ['Ghost Press'] },
        { name: 'Zercher Squat', subs: ['Ghost Press', 'Leg Press'] },
      ],
      known,
    )
    expect(unknown).toEqual(['Ghost Press', 'Zercher Squat'])
  })

  it('accepts a program with no exercises yet', () => {
    expect(findUnknownExercises([], known)).toEqual([])
  })

  it('accepts an exercise with no substitutes', () => {
    expect(findUnknownExercises([{ name: 'Leg Press' }], known)).toEqual([])
  })
})
