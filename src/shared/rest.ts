/**
 * Converts a rest label into seconds so a rest timer can consume it.
 *
 * Legacy values are display strings written for humans — "60 sec", "90 sec",
 * "2 min", "3–4 min" (note the en-dash). A range yields a tuple; anything
 * unparseable yields null rather than a guess.
 */

const RANGE = /^\s*(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*(sec|second|seconds|min|minute|minutes)\s*$/i
const SINGLE = /^\s*(\d+(?:\.\d+)?)\s*(sec|second|seconds|min|minute|minutes)\s*$/i

const toSeconds = (value: number, unit: string) =>
  Math.round(unit.toLowerCase().startsWith('min') ? value * 60 : value)

export function parseRestSeconds(rest: string): number | [number, number] | null {
  if (!rest) return null

  const range = RANGE.exec(rest)
  if (range) {
    const [, low, high, unit] = range
    return [toSeconds(Number(low), unit!), toSeconds(Number(high), unit!)]
  }

  const single = SINGLE.exec(rest)
  if (single) {
    const [, value, unit] = single
    return toSeconds(Number(value), unit!)
  }

  return null
}
