/**
 * Domain model. Mirrors the consolidated schema in DESIGN.md §2.
 *
 * Numeric fields are `number | null` throughout — never strings, never "". The
 * legacy table stored every weight/rep/RIR as a string; the migration coerces.
 */

export type WeightUnit = 'lbs' | 'kg'
export type TimeOfDay = 'morning' | 'afternoon' | 'night'
export type FiveThreeOneWeek = 1 | 2 | 3 | 'deload'

/** Chronological ordinals: keys sort correctly, where alphabetical would not. */
export const TIME_OF_DAY_ORDINAL: Record<TimeOfDay, number> = {
  morning: 1,
  afternoon: 2,
  night: 3,
}

export interface ItemEnvelope {
  entityType: string
  createdAt: string
  updatedAt: string
  version: number
  schemaVersion: number
  deleted?: boolean
}

export interface SetEntry {
  setNumber: number
  weight: number | null
  reps: number | null
  rir: number | null
  /** 5/3/1 only — computed target weight and prescription label for the set. */
  isWarmup?: boolean
  label?: string
  target?: number | null
}

export interface SessionExercise {
  slotId: string
  name: string
  swappedName?: string
  supplemental?: boolean
  weightUnit: WeightUnit
  note?: string
  sets: SetEntry[]
  /** Owner-only 5/3/1 fields. `trainingMax` is snapshotted deliberately — it moves every few weeks. */
  is531?: boolean
  week?: FiveThreeOneWeek
  trainingMax?: number
}

export interface Session {
  sessionType: string
  date: string
  startedAt: string
  programVersion: number
  tags: string[]
  notes?: string
  fiveDay?: boolean
  exercises: SessionExercise[]
}

/** A substitute is either a plain exercise name or one carrying programming overrides. */
export type ProgramSub =
  | string
  | {
      name: string
      sets?: number
      repRange?: [number, number]
      rir?: number
      perSide?: boolean
    }

export interface ProgramExercise {
  slotId: string
  name: string
  sets: number
  repRange: [number, number] | null
  rir: number | null
  /** Human-readable, e.g. "90 sec" or "3–4 min". */
  rest: string
  /** Parseable form of `rest`; a range becomes a tuple. */
  restSeconds: number | [number, number] | null
  subs: ProgramSub[]
  superset?: string
  perSide?: boolean
  optional?: boolean
  is531?: boolean
  note?: string
}

export interface Program {
  id: string
  name: string
  /** Descriptive label only — never enforced against the calendar. */
  day: string
  focus: string
  exercises: ProgramExercise[]
}

export interface Exercise {
  /** Immutable identifier. New exercises use `<slug>-<timestamp>`. */
  name: string
  /** User-facing label; the only field a rename changes. */
  displayName: string
  muscleGroups: string[]
  family: string | null
  defaultRepRange: [number, number] | null
  defaultSets: number | null
  unilateral?: boolean
}

export interface ExerciseHistoryEntry {
  slug: string
  date: string
  sessionType: string
  slotId: string
  sets: SetEntry[]
  weightUnit: WeightUnit
  note?: string
}

export interface Tag {
  id: string
  name: string
  color: { bg: string; text: string }
  deleted?: boolean
}

export interface BodyweightEntry {
  date: string
  timeOfDay: TimeOfDay
  weight: number
  weightUnit: WeightUnit
}

export interface FiveThreeOneConfig {
  exercise: string
  trainingMax: number
  history: Array<{ date: string; tm: number }>
}

export const FEATURE_FLAGS = [
  'fiveThreeOne',
  'planDoc',
  'intervalTimer',
  'progressionGuide',
] as const

export type FeatureFlag = (typeof FEATURE_FLAGS)[number]
export type FeatureMap = Record<FeatureFlag, boolean>

export interface Profile {
  sub: string
  email: string
  defaultWeightUnit: WeightUnit
  isOwner: boolean
  featureOverrides?: Partial<FeatureMap>
}
