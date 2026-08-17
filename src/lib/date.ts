/**
 * Local-timezone-safe ISO date (YYYY-MM-DD) formatting.
 *
 * NEVER use `date.toISOString().slice(0, 10)` for this. `toISOString()`
 * converts to UTC first — for a local-midnight Date during any positive
 * UTC offset (British Summer Time included: UTC+1 for roughly seven
 * months of the year), that conversion rolls the calendar date back by
 * one full day. Every Date object in this app is built from local Y/M/D
 * components (`new Date(year, month, day)`, `resolvePayday`, `addMonths`,
 * etc.), so formatting has to round-trip through the same local getters,
 * not UTC ones, or dates silently drift a day early for any UK user
 * during BST.
 */
export function toLocalIsoDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayIso(): string {
  return toLocalIsoDate(new Date())
}
