import { describe, expect, it } from 'vitest'
import {
  findDuplicateKeys,
  isStubSession,
  migrateBodyweight,
  migrateCatalogExercise,
  migrateProgram,
  migrateSession,
  toNumber,
  toSession,
  toUnit,
} from '../scripts/transforms'

const SUB = 'owner-sub'
const NOW = '2026-08-24T00:00:00.000Z'

describe('numeric coercion', () => {
  // Every one of the 1,826 legacy sets stores these as strings, with "" for blank.
  it('parses the legacy string encoding', () => {
    expect(toNumber('245')).toBe(245)
    expect(toNumber('16.5')).toBe(16.5)
  })

  it('treats the empty string as absent, not zero', () => {
    // Coercing "" to 0 would invent a 0 lb set that was never performed.
    expect(toNumber('')).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
  })

  it('passes real numbers through, as bodyweight already stores them', () => {
    expect(toNumber(179.4)).toBe(179.4)
  })

  it('returns null rather than NaN for junk', () => {
    expect(toNumber('heavy')).toBeNull()
  })

  it('preserves kg and defaults everything else to lbs', () => {
    expect(toUnit('kg')).toBe('kg')
    expect(toUnit('lbs')).toBe('lbs')
    expect(toUnit(undefined)).toBe('lbs')
  })
})

describe('stub session detection', () => {
  /** These two records crashed an analysis script written to the documented shape. */
  it('recognises the abandoned notes-only records', () => {
    expect(isStubSession({ PK: 'SESSION#lower-a', SK: 'DATE#2026-06-06', notes: '' })).toBe(true)
  })

  it('recognises a session with an empty exercise array', () => {
    expect(isStubSession({ exercises: [] })).toBe(true)
  })

  it('keeps a real session', () => {
    expect(isStubSession({ exercises: [{ name: 'Leg Press' }] })).toBe(false)
  })
})

describe('session migration', () => {
  const legacySession = (overrides: Record<string, unknown> = {}) => ({
    PK: 'SESSION#lower-a',
    SK: 'DATE#2026-08-24',
    sessionType: 'lower-a',
    date: '2026-08-24',
    startedAt: '2026-08-24T18:00:00.000Z',
    exercises: [
      {
        slotId: 'la-legpress',
        name: 'Leg Press',
        weightUnit: 'lbs',
        sets: [{ setNumber: 1, weight: '305', reps: '12', rir: '2' }],
      },
    ],
    ...overrides,
  })

  it('coerces every set value to numbers', () => {
    const session = toSession(legacySession())
    expect(session.exercises[0]!.sets[0]).toMatchObject({ weight: 305, reps: 12, rir: 2 })
  })

  it('copies slotIds verbatim rather than recomputing from position', () => {
    // Recomputing would reintroduce the reorder-corruption bug this schema exists to fix.
    expect(toSession(legacySession()).exercises[0]!.slotId).toBe('la-legpress')
  })

  it('generates a slotId for supplementals, which have no program slot', () => {
    const session = toSession(
      legacySession({
        exercises: [{ name: 'Cable Crunch', supplemental: true, weightUnit: 'lbs', sets: [] }],
      }),
    )
    expect(session.exercises[0]!.slotId).toMatch(/^supp-/)
    expect(session.exercises[0]!.supplemental).toBe(true)
  })

  it('gives two supplementals of the same exercise distinct slots', () => {
    const session = toSession(
      legacySession({
        exercises: [
          { name: 'Cable Crunch', supplemental: true, weightUnit: 'lbs', sets: [] },
          { name: 'Cable Crunch', supplemental: true, weightUnit: 'lbs', sets: [] },
        ],
      }),
    )
    expect(session.exercises[0]!.slotId).not.toBe(session.exercises[1]!.slotId)
  })

  it('converts the legacy deload boolean into a tag', () => {
    const session = toSession(legacySession({ deload: true }))
    expect(session.tags).toContain('deload')
    expect(session).not.toHaveProperty('deload')
  })

  it('does not duplicate the tag when both forms are present', () => {
    const session = toSession(legacySession({ deload: true, tags: ['deload', 'vital'] }))
    expect(session.tags.filter((t) => t === 'deload')).toHaveLength(1)
  })

  it('leaves a session without deload untouched', () => {
    expect(toSession(legacySession({ tags: ['crunch'] })).tags).toEqual(['crunch'])
  })

  it('carries the fiveDay volume toggle across', () => {
    expect(toSession(legacySession({ fiveDay: true })).fiveDay).toBe(true)
    expect(toSession(legacySession({ fiveDay: false })).fiveDay).toBe(false)
    expect(toSession(legacySession())).not.toHaveProperty('fiveDay')
  })

  it('preserves 5/3/1 fields including the training-max snapshot', () => {
    const session = toSession(
      legacySession({
        exercises: [
          {
            slotId: 'la-squat',
            name: 'Barbell Back Squat',
            is531: true,
            week: 1,
            trainingMax: 335,
            weightUnit: 'lbs',
            sets: [
              { setNumber: 1, weight: '', reps: '', rir: '', isWarmup: true, label: '1×5', target: 135 },
            ],
          },
        ],
      }),
    )

    const exercise = session.exercises[0]!
    expect(exercise).toMatchObject({ is531: true, week: 1, trainingMax: 335 })
    expect(exercise.sets[0]).toMatchObject({ isWarmup: true, label: '1×5', target: 135 })
  })

  it('stamps programVersion 1 so historical target lookups resolve', () => {
    expect(toSession(legacySession()).programVersion).toBe(1)
  })

  it('corrects the single known weight typo', () => {
    const session = toSession({
      sessionType: 'upper-b',
      date: '2026-07-17',
      exercises: [
        {
          slotId: 'ub-row',
          name: 'Chest-Supported DB Row',
          swappedName: 'Iso-Lateral Low Row',
          weightUnit: 'lbs',
          sets: [
            { setNumber: 1, weight: '185', reps: '12', rir: '3' },
            { setNumber: 2, weight: '205', reps: '12', rir: '2' },
            { setNumber: 3, weight: '2250', reps: '10', rir: '2' },
          ],
        },
      ],
    })

    expect(session.exercises[0]!.sets[2]!.weight).toBe(225)
    expect(session.exercises[0]!.sets[0]!.weight).toBe(185)
  })

  it('leaves an identical weight in any other session alone', () => {
    // The correction is pinned to one date, slot, and set — it is not a blanket rule.
    const session = toSession({
      sessionType: 'upper-b',
      date: '2026-08-07',
      exercises: [
        {
          slotId: 'ub-row',
          name: 'Row',
          weightUnit: 'lbs',
          sets: [{ setNumber: 3, weight: '2250', reps: '10', rir: '2' }],
        },
      ],
    })
    expect(session.exercises[0]!.sets[0]!.weight).toBe(2250)
  })

  it('emits the session item plus one history entry per logged exercise', () => {
    const items = migrateSession(legacySession(), SUB, NOW)
    expect(items).toHaveLength(2)
    expect(items[0]!.PK).toBe('USER#owner-sub#SESSION#lower-a')
    expect(items[1]!.SK).toContain('EXERCISE_HISTORY#Leg Press#2026-08-24#lower-a#la-legpress')
  })

  it('projects sessions into GSI1 for the calendar view', () => {
    const session = migrateSession(legacySession(), SUB, NOW)[0] as unknown as Record<string, unknown>
    expect(session['GSI1PK']).toBe('USER#owner-sub')
    expect(session['GSI1SK']).toBe('DATE#2026-08-24')
  })
})

describe('program migration', () => {
  const legacyProgram = {
    PK: 'PROGRAM#spring2026',
    SK: 'SESSION_TYPE#lower-a',
    name: 'Lower A',
    day: 'Monday',
    focus: 'Strength',
    exercises: [
      {
        slotId: 'la-squat',
        name: 'Barbell Back Squat',
        sets: 3,
        repRange: [10, 12],
        rir: 2,
        rest: '3–4 min',
        subs: ['Hack Squat', { name: 'Bulgarian Split Squat', sets: 2 }],
      },
    ],
  }

  it('emits the current program and a version-1 snapshot', () => {
    const [program, snapshot] = migrateProgram(legacyProgram, SUB, NOW)
    expect(program!.SK).toBe('SESSION_TYPE#lower-a')
    expect(snapshot!.SK).toBe('PROGRAM_VERSION#lower-a#00001')
    expect(snapshot!.entityType).toBe('PROGRAM_VERSION')
  })

  it('normalises the rest string into seconds for the rest timer', () => {
    const [program] = migrateProgram(legacyProgram, SUB, NOW)
    expect(program!.exercises[0]!.restSeconds).toEqual([180, 240])
    expect(program!.exercises[0]!.rest).toBe('3–4 min')
  })

  it('preserves both substitute shapes', () => {
    const [program] = migrateProgram(legacyProgram, SUB, NOW)
    expect(program!.exercises[0]!.subs).toEqual([
      'Hack Squat',
      { name: 'Bulgarian Split Squat', sets: 2 },
    ])
  })
})

describe('catalog migration', () => {
  it('drops the lossy history cache, which is rebuilt from sessions', () => {
    const item = migrateCatalogExercise(
      {
        PK: 'EXERCISE_LIB',
        SK: 'EXERCISE#leg-press',
        name: 'Leg Press',
        displayName: 'Leg Press',
        muscleGroups: ['quads'],
        history: [{ date: '2026-01-01', sets: [] }],
      },
      NOW,
    )

    expect(item).not.toHaveProperty('history')
    expect(item.PK).toBe('EXERCISE_LIB_DEFAULT')
  })

  it('falls back to name when displayName is absent', () => {
    const item = migrateCatalogExercise({ name: 'Leg Press', muscleGroups: [] }, NOW)
    expect(item.displayName).toBe('Leg Press')
  })
})

describe('bodyweight migration', () => {
  it('keys on date and time of day so both weigh-ins survive', () => {
    const morning = migrateBodyweight(
      { date: '2026-08-24', timeOfDay: 'morning', weight: 179.4, weightUnit: 'lbs' },
      SUB,
      NOW,
    )
    const night = migrateBodyweight(
      { date: '2026-08-24', timeOfDay: 'night', weight: 181.2, weightUnit: 'lbs' },
      SUB,
      NOW,
    )

    expect(morning.SK).not.toBe(night.SK)
    expect(morning.SK < night.SK).toBe(true)
  })

  it('defaults an unrecognised time of day rather than dropping the entry', () => {
    const item = migrateBodyweight({ date: '2026-08-24', weight: 180 }, SUB, NOW)
    expect(item.timeOfDay).toBe('morning')
  })
})

describe('duplicate key guard', () => {
  /** A duplicate inside a batch write overwrites silently, losing data with no error. */
  it('catches two items sharing a key', () => {
    const dupes = findDuplicateKeys([
      { PK: 'USER#a', SK: 'PROFILE' },
      { PK: 'USER#a', SK: 'PROFILE' },
    ])
    expect(dupes).toEqual(['USER#a | PROFILE'])
  })

  it('passes a set of distinct keys', () => {
    expect(
      findDuplicateKeys([
        { PK: 'USER#a', SK: 'PROFILE' },
        { PK: 'USER#a', SK: 'TAGS' },
      ]),
    ).toEqual([])
  })
})
