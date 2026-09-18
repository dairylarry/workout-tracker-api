import { describe, expect, it } from 'vitest'
import {
  BODYWEIGHT_PREFIX,
  DEFAULT_LIBRARY_PK,
  PROGRAM_PREFIX,
  bodyweightSk,
  exerciseHistoryPrefix,
  exerciseHistorySk,
  gsi1SessionKeys,
  programSk,
  programVersionSk,
  sessionPk,
  sessionSk,
  userPk,
} from '../src/shared/keys'
import { TIME_OF_DAY_ORDINAL, type TimeOfDay } from '../src/shared/types'

describe('program version keys', () => {
  it('zero-pads so versions sort lexically in DynamoDB order', () => {
    const sorted = [1, 2, 10, 11, 100].map((v) => programVersionSk('upper-a', v)).sort()

    expect(sorted).toEqual([
      programVersionSk('upper-a', 1),
      programVersionSk('upper-a', 2),
      programVersionSk('upper-a', 10),
      programVersionSk('upper-a', 11),
      programVersionSk('upper-a', 100),
    ])
  })

  /**
   * The whole reason archived versions use a distinct prefix: GET /programs is a
   * begins_with on PROGRAM_PREFIX and must never pick up archived versions.
   */
  it('does not collide with the current-program prefix query', () => {
    expect(programVersionSk('upper-a', 3).startsWith(PROGRAM_PREFIX)).toBe(false)
    expect(programSk('upper-a').startsWith(PROGRAM_PREFIX)).toBe(true)
  })
})

describe('bodyweight keys', () => {
  /**
   * Alphabetically "afternoon" < "morning" < "night", which is not chronological.
   * The ordinal prefix is what keeps a day's entries in the order they happened.
   */
  it('sorts a single day chronologically, which alphabetical order would not', () => {
    const order: TimeOfDay[] = ['night', 'morning', 'afternoon']
    const sorted = order.map((t) => bodyweightSk('2026-08-24', t)).sort()

    expect(sorted.map((sk) => sk.split('#').pop())).toEqual(['morning', 'afternoon', 'night'])
  })

  it('lets morning and night coexist on the same date', () => {
    expect(bodyweightSk('2026-08-24', 'morning')).not.toBe(bodyweightSk('2026-08-24', 'night'))
  })

  it('stays within the prefix used to list entries', () => {
    expect(bodyweightSk('2026-08-24', 'morning').startsWith(BODYWEIGHT_PREFIX)).toBe(true)
  })

  it('assigns ordinals in chronological order', () => {
    expect(TIME_OF_DAY_ORDINAL.morning).toBeLessThan(TIME_OF_DAY_ORDINAL.afternoon)
    expect(TIME_OF_DAY_ORDINAL.afternoon).toBeLessThan(TIME_OF_DAY_ORDINAL.night)
  })
})

describe('exercise history keys', () => {
  it('is reachable by the prefix used to query one exercise', () => {
    const sk = exerciseHistorySk('Hack Squat', '2026-08-24', 'lower-a', 'la-legpress')
    expect(sk.startsWith(exerciseHistoryPrefix('Hack Squat'))).toBe(true)
  })

  it('orders one exercise newest-last so a descending query yields newest-first', () => {
    const older = exerciseHistorySk('Leg Press', '2026-07-01', 'lower-a', 'la-legpress')
    const newer = exerciseHistorySk('Leg Press', '2026-08-24', 'lower-a', 'la-legpress')
    expect(older < newer).toBe(true)
  })

  it('separates the same exercise logged in different session types on one date', () => {
    const a = exerciseHistorySk('Cable Lateral Raise', '2026-08-24', 'upper-a', 'ua-lateral')
    const b = exerciseHistorySk('Cable Lateral Raise', '2026-08-24', 'upper-b', 'ub-lateral')
    expect(a).not.toBe(b)
  })
})

describe('partition layout', () => {
  it('puts sessions in a per-type partition, separate from the user partition', () => {
    expect(sessionPk('abc', 'lower-a')).toBe('USER#abc#SESSION#lower-a')
    expect(sessionPk('abc', 'lower-a')).not.toBe(userPk('abc'))
  })

  it('keeps the default catalog outside any user namespace', () => {
    expect(DEFAULT_LIBRARY_PK.startsWith('USER#')).toBe(false)
  })

  it('projects sessions into GSI1 under the user, keyed by date', () => {
    expect(gsi1SessionKeys('abc', '2026-08-24')).toEqual({
      GSI1PK: 'USER#abc',
      GSI1SK: 'DATE#2026-08-24',
    })
  })

  it('matches the calendar query prefix for the month', () => {
    const { GSI1SK } = gsi1SessionKeys('abc', '2026-08-24')
    expect(GSI1SK.startsWith('DATE#2026-08')).toBe(true)
  })

  it('orders sessions within a partition by date', () => {
    expect(sessionSk('2026-07-01') < sessionSk('2026-08-24')).toBe(true)
  })
})
