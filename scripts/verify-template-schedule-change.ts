// 2026-09-16 (Adam-reported, a sibling of PROMPT-02 Task B) — changing a
// bill's due date "for every payment from then on", from a chosen payment,
// duplicated the payment instead of moving it. Mum's backup: "Agria Pet
// Insurance - Pippa" 15th -> 16th, from yesterday's (15 Sep) payment, left
// a cleared 15 Sep AND a cleared 16 Sep.
//
// Root cause: the "all future" branch just overwrote `anchorDate` and
// ignored the chosen payment. A materialised occurrence is identified by
// its slot (APP-KNOWLEDGE §1.5a); with a new anchor, no existing row's slot
// is produced any more, so the generator materialised every occurrence
// since the anchor again on the new day. 21 of mum's 29 bills showed it. A
// frequency change had the same cause, and recurring transactions/transfers
// saved date and frequency changes immediately with no "from which payment"
// step at all.
//
// Fixed by applyTemplateScheduleChange (lib/schedule.ts). Section 1 fails
// against the old `{ anchorDate: draft.anchorDate }` behaviour, emulated by
// `oldBehaviour` below.

import { readFileSync } from 'node:fs'
import { defaultLedgerData, defaultPayCycleConfig, parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { applyTemplateScheduleChange, recentAndUpcomingOccurrences, type TemplateSchedule } from '../src/lib/schedule'
import { parseLocalDate } from '../src/lib/date'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const TODAY = '2026-09-16'
const asOf = parseLocalDate(TODAY)

function change(data: AppDataV2, templateId: string, next: TemplateSchedule, fromDate: string): AppDataV2 {
  const template = data.recurringTemplates.find((t) => t.id === templateId)!
  const { patch, transactions } = applyTemplateScheduleChange(template, data.transactions, next, fromDate, TODAY)
  return autoClearDuePayments({ ...data, transactions, recurringTemplates: data.recurringTemplates.map((t) => (t.id === templateId ? { ...t, ...patch } : t)) }, asOf)
}
function oldBehaviour(data: AppDataV2, templateId: string, next: TemplateSchedule): AppDataV2 {
  return autoClearDuePayments({ ...data, recurringTemplates: data.recurringTemplates.map((t) => (t.id === templateId ? { ...t, ...next } : t)) }, asOf)
}
const rowsOf = (data: AppDataV2, id: string): Transaction[] =>
  data.transactions.filter((t) => t.sourceType === 'recurring_template' && t.sourceId === id).sort((a, b) => a.date.localeCompare(b.date))
const dates = (rows: Transaction[]) => rows.map((t) => `${t.date}:${t.status}`)

// A bill with 20 months of cleared history.
const base = defaultLedgerData()
const ME = base.primaryPersonId
const bill: RecurringTemplate = {
  id: 'bill',
  name: 'Insurance',
  amount: 68.58,
  categoryId: 'category-bills',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2025-01-15',
  location: 'personal',
  ownerId: ME,
  payee: '',
  payeeSharePercent: 100,
  active: true,
}
const longHistory = autoClearDuePayments(
  { ...base, recurringTemplates: [bill], payCycles: [{ ...defaultPayCycleConfig(ME), openingBalance: 1000, openingBalanceDate: '2025-01-01' }] },
  asOf,
)
const history = rowsOf(longHistory, 'bill')
check('[fixture] 21 cleared monthly payments, 15 Jan 2025 → 15 Sep 2026', [history.length, history[0].date, history.at(-1)!.date], [21, '2025-01-15', '2026-09-15'])
const on16th: TemplateSchedule = { frequency: 'monthly', anchorDate: '2025-01-16' }

// ─────────────────────────────────────────────────────────────────────
// 1. The reported bug: 15th → 16th, from yesterday's payment
// ─────────────────────────────────────────────────────────────────────
{
  const before = oldBehaviour(longHistory, 'bill', on16th)
  check('[old behaviour, for the record] the history was duplicated on the 16th', rowsOf(before, 'bill').length, 42)

  const after = change(longHistory, 'bill', on16th, '2026-09-15')
  const rows = rowsOf(after, 'bill')
  check('no payment is duplicated', rows.length, 21)
  check("yesterday's payment moved to the 16th rather than being duplicated", dates(rows.filter((t) => t.date >= '2026-09-01')), ['2026-09-16:cleared'])
  check('every payment before it keeps its old date and row', rows.slice(0, 20), history.slice(0, 20))
  check('the moved payment keeps its id and amount', [rows.at(-1)!.id, rows.at(-1)!.amount], [history.at(-1)!.id, history.at(-1)!.amount])
  check('its slot is the new one', rows.at(-1)!.occurrenceOriginalDate, '2026-09-16')
  check('the schedule continues on the 16th', recentAndUpcomingOccurrences(after.recurringTemplates[0], asOf).map((o) => o.date), ['2026-09-16', '2026-10-16', '2026-11-16', '2026-12-16'])
  check('stable: running auto-clear again changes nothing', JSON.stringify(autoClearDuePayments(after, asOf).transactions), JSON.stringify(after.transactions))
}

// ─────────────────────────────────────────────────────────────────────
// 2. Other directions and choices
// ─────────────────────────────────────────────────────────────────────
{
  const upcoming = change(longHistory, 'bill', on16th, '2026-10-15')
  check('from an UPCOMING payment: every cleared payment is untouched', rowsOf(upcoming, 'bill'), history)
  check('...and the next payment is 16 Oct', recentAndUpcomingOccurrences(upcoming.recurringTemplates[0], parseLocalDate('2026-09-17')).map((o) => o.date).slice(0, 2), ['2026-10-16', '2026-11-16'])

  const earlier = change(longHistory, 'bill', { frequency: 'monthly', anchorDate: '2025-01-10' }, '2026-09-15')
  check('moving EARLIER (15th → 10th): same count, 15 Sep becomes 10 Sep, no 10 Aug appears', [rowsOf(earlier, 'bill').length, dates(rowsOf(earlier, 'bill').slice(-2))], [21, ['2026-08-15:cleared', '2026-09-10:cleared']])

  const later = change(longHistory, 'bill', { frequency: 'monthly', anchorDate: '2025-01-20' }, '2026-09-15')
  check('moving LATER past today (15th → 20th): 15 Sep becomes a PENDING 20 Sep', dates(rowsOf(later, 'bill').slice(-2)), ['2026-08-15:cleared', '2026-09-20:pending'])

  const fromEarlierPayment = change(longHistory, 'bill', on16th, '2026-07-15')
  check('from a payment two months back: Jul, Aug, Sep all move, nothing duplicates', [rowsOf(fromEarlierPayment, 'bill').length, dates(rowsOf(fromEarlierPayment, 'bill').slice(-4))], [21, ['2026-06-15:cleared', '2026-07-16:cleared', '2026-08-16:cleared', '2026-09-16:cleared']])
}

// ─────────────────────────────────────────────────────────────────────
// 3. Frequency changes
// ─────────────────────────────────────────────────────────────────────
{
  const weekly = change(longHistory, 'bill', { frequency: 'weekly', anchorDate: '2025-01-15' }, '2026-09-15')
  const rows = rowsOf(weekly, 'bill')
  check('monthly → weekly: no phantom weekly payments in the past history', rows.filter((t) => t.date < '2026-09-01'), history.slice(0, 20))
  const september = rows.filter((t) => t.date >= '2026-09-01')
  // The anchor (15 Jan 2025) is a Wednesday, so the weekly run is on
  // Wednesdays: Tuesday 15 Sep's payment moves to the nearest, 16 Sep.
  check('monthly → weekly: the Sep payment moves to the nearest weekly day (Wed 16 Sep), nothing duplicated', dates(september), ['2026-09-16:cleared'])
  check('...and it is the SAME row, re-slotted', september[0].id, history.at(-1)!.id)

  const weeklyBill: RecurringTemplate = { ...bill, id: 'weekly', frequency: 'weekly', anchorDate: '2026-06-02' }
  const weeklyData = autoClearDuePayments({ ...longHistory, recurringTemplates: [weeklyBill], transactions: [] }, asOf)
  const weeklyRows = rowsOf(weeklyData, 'weekly')
  const toMonthly = change(weeklyData, 'weekly', { frequency: 'monthly', anchorDate: '2026-06-02' }, '2026-09-15')
  const monthlyRows = rowsOf(toMonthly, 'weekly')
  check('weekly → monthly from 15 Sep: earlier weekly payments untouched', monthlyRows.filter((t) => t.date < '2026-09-15'), weeklyRows.filter((t) => t.date < '2026-09-15'))
  check('weekly → monthly: the 15 Sep payment becomes the first monthly one, no duplicate', dates(monthlyRows.filter((t) => t.date >= '2026-09-15')), ['2026-10-02:pending'])
}

// ─────────────────────────────────────────────────────────────────────
// 4. Per-payment overrides follow their payment
// ─────────────────────────────────────────────────────────────────────
{
  const withOverrides: AppDataV2 = {
    ...longHistory,
    recurringTemplates: [
      {
        ...bill,
        occurrenceOverrides: [
          { originalDate: '2026-09-15', amount: 70, date: '2026-09-15' }, // a single-payment amount edit also writes date = its own slot
          { originalDate: '2026-10-15', amount: 99 },
          { originalDate: '2026-11-15', deleted: true },
          { originalDate: '2026-12-15', date: '2026-12-20' }, // a genuine move
          { originalDate: '2026-06-15', amount: 60 }, // before the chosen payment: untouched
        ],
      },
    ],
  }
  const after = change(withOverrides, 'bill', on16th, '2026-09-15')
  const o = after.recurringTemplates[0].occurrenceOverrides!
  check('an amount edit on 15 Oct now applies to 16 Oct', o.find((x) => x.amount === 99)?.originalDate, '2026-10-16')
  check('a paused 15 Nov is now a paused 16 Nov', o.find((x) => x.deleted)?.originalDate, '2026-11-16')
  check('a genuine move keeps the date the user chose', o.find((x) => x.date === '2026-12-20')?.originalDate, '2026-12-16')
  check("an override whose date was just its own slot follows the new slot", o.find((x) => x.amount === 70), { originalDate: '2026-09-16', amount: 70, date: '2026-09-16' })
  check('an override before the chosen payment is untouched', o.find((x) => x.amount === 60)?.originalDate, '2026-06-15')
  check('the upcoming schedule honours them: 16 Oct £99, 16 Nov skipped, 20 Dec', recentAndUpcomingOccurrences(after.recurringTemplates[0], asOf).map((x) => x.date), ['2026-09-16', '2026-10-16', '2026-12-20', '2027-01-16'])
}

// ─────────────────────────────────────────────────────────────────────
// 5. Mum's real backup — every template, day +1 from its most recent payment
// ─────────────────────────────────────────────────────────────────────
{
  const BACKUP = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json'
  const loaded = autoClearDuePayments(parseLedgerBackupJson(readFileSync(BACKUP, 'utf8')), asOf)
  const agria = loaded.recurringTemplates.find((t) => t.name === 'Agria Pet Insurance - Pippa')!
  const reported = change(loaded, agria.id, { frequency: 'monthly', anchorDate: '2026-09-16' }, '2026-09-15')
  check("[mum] Agria Pet Insurance - Pippa, 15th → 16th from 15 Sep: one payment, on the 16th", dates(rowsOf(reported, agria.id)), ['2026-09-16:cleared'])

  let exercised = 0
  for (const t of loaded.recurringTemplates) {
    const recent = recentAndUpcomingOccurrences(t, asOf)[0]
    if (!recent?.isPast) continue
    const day = Number(t.anchorDate.slice(8))
    const next: TemplateSchedule = { frequency: t.frequency, intervalWeeks: t.intervalWeeks, anchorDate: `${t.anchorDate.slice(0, 8)}${String(day >= 28 ? day - 1 : day + 1).padStart(2, '0')}` }
    const before = rowsOf(loaded, t.id)
    const after = rowsOf(change(loaded, t.id, next, recent.date), t.id)
    check(`[mum] ${t.name}: no duplicate after moving the date from ${recent.date}`, after.length, before.length)
    exercised++
  }
  check('[mum] templates exercised', exercised > 20, true)
}

console.log(failures === 0 ? '\nAll template schedule-change checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)
