import { describe, expect, it } from 'vitest'
import { parseRestSeconds } from '../src/shared/rest'

describe('rest string parsing', () => {
  // The four formats that actually occur across all 49 program exercises in the
  // legacy table. If migration silently produced nulls, the rest timer gets nothing.
  it.each([
    ['60 sec', 60],
    ['90 sec', 90],
    ['2 min', 120],
  ])('parses the legacy single value %s', (input, expected) => {
    expect(parseRestSeconds(input)).toBe(expected)
  })

  it('parses the en-dash range used for heavy compounds', () => {
    expect(parseRestSeconds('3–4 min')).toEqual([180, 240])
  })

  it('accepts hyphen and em-dash ranges too', () => {
    expect(parseRestSeconds('3-4 min')).toEqual([180, 240])
    expect(parseRestSeconds('3—4 min')).toEqual([180, 240])
  })

  it('handles singular and long-form units', () => {
    expect(parseRestSeconds('1 minute')).toBe(60)
    expect(parseRestSeconds('45 seconds')).toBe(45)
  })

  it('is insensitive to case and surrounding whitespace', () => {
    expect(parseRestSeconds('  90 SEC  ')).toBe(90)
  })

  it('returns null rather than guessing at unparseable text', () => {
    expect(parseRestSeconds('as needed')).toBeNull()
    expect(parseRestSeconds('')).toBeNull()
    expect(parseRestSeconds('90')).toBeNull()
  })
})
