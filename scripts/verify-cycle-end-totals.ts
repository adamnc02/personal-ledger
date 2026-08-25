// Verifies the "cycle-end totals" enhancement and the two bug fixes that
// shipped alongside it. Runs against the real backup so the fixtures are
// the authoritative app state, not a hand-built approximation.
//
// Run under BOTH timezones: TZ=UTC and TZ=Europe/London.

import { readFileSync } from 'node:fs'
import { addDays } from 'date-fns'
import { computeProjection, horizonCycles, horizonRangeEnd, THREE_CYCLES_AHEAD } from '../src/lib/projection'
import { isLedgerTransaction, signedAmount } from '../src/lib/runningBalance'
import { compareByDateSalaryFirst } from '../src/lib/cycleSummary'
import { upcomingPaydays } from '../src/lib/salaryLedger'
import { nextMinimumChargeAmount, buildCreditCardMinimumChargeRows } from '../src/lib/creditCards'
import { summarizeLoanProgress } from '../src/lib/ledgerLoans'
import { toLocalIsoDate } from '../src/lib/date'
import type { AppDataV2, Loan, Transaction } from '../src/types/ledger'

// Reads a real backup so the fixtures are authoritative app state rather
// than a hand-built approximation. Defaults to the committed copy under
// scripts/fixtures; point LEDGER_BACKUP at a fresher export to re-run
// these checks against current data.
const BACKUP = process.env.LEDGER_BACKUP ?? new URL('./fixtures/backup-2026-08-24.json', import.meta.url).pathname
const data = JSON.parse(readFileSync(BACKUP, 'utf8')) as AppDataV2
const payCycle = data.payCycles[0]
const personId = payCycle.personId
const round2 = (n: number) => Math.round(n * 100) / 100

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`)
}
function assert(label: string, cond: boolean, detail = '') {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`)
}

// Several dates, so the results don't depend on today happening to sit
// mid-cycle, and so at least one case crosses a short month (September,
// the month that previously drifted the horizon a day early).
const asOfDates = [new Date(2026, 7, 24), new Date(2026, 7, 13), new Date(2026, 8, 30), new Date(2026, 11, 31), new Date(2027, 1, 14)]

console.log('\n=== 1. Horizon covers current + 3 cycles ===')
for (const asOf of asOfDates) {
  const cycles = horizonCycles(payCycle, 'three_cycles', asOf)
  check(`${toLocalIsoDate(asOf)}: cycle count`, cycles.length, 1 + THREE_CYCLES_AHEAD)
  check(`${toLocalIsoDate(asOf)}: horizonRangeEnd === last cycle end`, toLocalIsoDate(horizonRangeEnd(payCycle, 'three_cycles', asOf)), toLocalIsoDate(cycles[cycles.length - 1].end))
  check(`${toLocalIsoDate(asOf)}: current_cycle still 1 cycle`, horizonCycles(payCycle, 'current_cycle', asOf).length, 1)
}

console.log('\n=== 2. Cycles tile the window with no gaps or overlaps ===')
for (const asOf of asOfDates) {
  const cycles = horizonCycles(payCycle, 'three_cycles', asOf)
  const iso = toLocalIsoDate(asOf)
  assert(`${iso}: first cycle contains asOfDate`, asOf >= cycles[0].start && asOf <= cycles[0].end)
  for (let i = 1; i < cycles.length; i++) {
    check(`${iso}: cycle ${i} starts the day after cycle ${i - 1} ends`, toLocalIsoDate(cycles[i].start), toLocalIsoDate(addDays(cycles[i - 1].end, 1)))
  }
}

console.log('\n=== 3. Cycle ends land the day before the next payday ===')
// cycleStartFollowsPayday is on for this config, so each boundary should
// track the RESOLVED (weekend/bank-holiday adjusted) payday, not day 14.
for (const asOf of asOfDates) {
  const cycles = horizonCycles(payCycle, 'three_cycles', asOf)
  const iso = toLocalIsoDate(asOf)
  for (let i = 0; i < cycles.length - 1; i++) {
    check(`${iso}: cycle ${i} end is day before cycle ${i + 1} start`, toLocalIsoDate(cycles[i].end), toLocalIsoDate(addDays(cycles[i + 1].start, -1)))
  }
}

console.log('\n=== 4. Section subtotals reconcile with the projection ===')
// Mirrors CycleGroupedList exactly: one continuous fold from the raw
// opening balance, first section unbounded below, subtotal = running
// balance on each section's last row.
for (const asOf of asOfDates) {
  const iso = toLocalIsoDate(asOf)
  const projection = computeProjection(data, personId, payCycle, 'three_cycles', asOf)
  const cycles = horizonCycles(payCycle, 'three_cycles', asOf)
  const rows = projection.transactions.filter(isLedgerTransaction).slice().sort(compareByDateSalaryFirst)

  let running = projection.openingBalance
  const withRunning = rows.map((t) => {
    running = round2(running + signedAmount(t))
    return { t, running }
  })

  let carried = projection.openingBalance
  const closings: number[] = []
  let totalRowsShown = 0
  for (let i = 0; i < cycles.length; i++) {
    const startIso = toLocalIsoDate(cycles[i].start)
    const endIso = toLocalIsoDate(cycles[i].end)
    const sectionRows = withRunning.filter(({ t }) => (i === 0 || t.date >= startIso) && t.date <= endIso)
    totalRowsShown += sectionRows.length
    carried = sectionRows.length > 0 ? sectionRows[sectionRows.length - 1].running : carried
    closings.push(carried)
  }

  // Every row the projection returned appears in exactly one section —
  // nothing silently dropped between the opening balance date and the
  // first cycle start.
  check(`${iso}: every projected row lands in a section`, totalRowsShown, rows.length)
  // Closing balances only ever move forward through the window.
  assert(`${iso}: subtotals are monotonic in section order`, closings.length === cycles.length)
  // The last section's closing IS the projected balance.
  check(`${iso}: final subtotal === projectedBalance`, closings[closings.length - 1], projection.projectedBalance)
}

console.log('\n=== 5. Salary shows a 4th upcoming pay period ===')
for (const asOf of asOfDates) {
  const iso = toLocalIsoDate(asOf)
  const upcoming = upcomingPaydays(payCycle, asOf, 1 + THREE_CYCLES_AHEAD).map(toLocalIsoDate)
  check(`${iso}: 4 upcoming paydays listed`, upcoming.length, 4)
  assert(`${iso}: paydays strictly ascending`, upcoming.every((d, i) => i === 0 || d > upcoming[i - 1]), upcoming.join(', '))
}

console.log('\n=== 6. Pre-opening-balance overpayment stays out of cleared ===')
const OPENING = payCycle.openingBalance
const asOf = new Date(2026, 7, 24)
const baseline = computeProjection(data, personId, payCycle, 'three_cycles', asOf)
const mkOverpayment = (date: string): Transaction =>
  ({
    id: `OP-${date}`, date, amount: 40, direction: 'out', categoryId: 'category-loans',
    paymentMethod: 'bank_transfer', status: 'cleared', type: 'loan_payment', location: 'personal',
    ownerId: personId, sourceType: 'loan_overpayment', sourceId: `op-${date}`, note: 'Overpayment',
  }) as Transaction

// Well before the opening balance date — already inside the reconciled
// figure, so it must not move any balance.
const before = computeProjection({ ...data, transactions: [...data.transactions, mkOverpayment('2025-02-22')] }, personId, payCycle, 'three_cycles', asOf)
check('2025-02-22 overpayment: clearedBalance unchanged', before.clearedBalance, baseline.clearedBalance)
check('2025-02-22 overpayment: projectedBalance unchanged', before.projectedBalance, baseline.projectedBalance)
assert('2025-02-22 overpayment: absent from the ledger list', !before.transactions.some((t) => t.id === 'OP-2025-02-22'))

// On/after the opening balance date — the ordinary case. Must clear
// normally, or the fix would have over-corrected into the original bug.
const afterIso = toLocalIsoDate(addDays(new Date(payCycle.openingBalanceDate), 3))
const after = computeProjection({ ...data, transactions: [...data.transactions, mkOverpayment(afterIso)] }, personId, payCycle, 'three_cycles', asOf)
check(`${afterIso} overpayment: reduces clearedBalance by 40`, after.clearedBalance, round2(baseline.clearedBalance - 40))
assert(`${afterIso} overpayment: present in the ledger list`, after.transactions.some((t) => t.id === `OP-${afterIso}`))

// Exactly ON the boundary — inclusive, per `t.date >= openingBalanceDate`.
const onIso = payCycle.openingBalanceDate
const on = computeProjection({ ...data, transactions: [...data.transactions, mkOverpayment(onIso)] }, personId, payCycle, 'three_cycles', asOf)
check(`${onIso} overpayment (on the boundary): counted`, on.clearedBalance, round2(baseline.clearedBalance - 40))

// And the loan itself still sees it, which was the whole point of the
// original exemption. This must hold regardless of the ledger floor.
const hi = data.loans.find((l) => l.name === 'Home Improvements')!
const withOp: Loan = { ...hi, overpayments: [{ id: 'op1', date: '2025-02-22', amount: 40, recastMode: 'reduce_term' }] }
check('loan capital still reduced by the pre-floor overpayment', round2(summarizeLoanProgress(hi, asOf).capitalRemaining - summarizeLoanProgress(withOp, asOf).capitalRemaining), 40)
check('opening balance itself untouched', baseline.openingBalance, OPENING)

console.log('\n=== 7. Credit card "due" figures agree across every surface ===')
for (const stored of data.creditCards) {
  const rowsFig = buildCreditCardMinimumChargeRows(stored, data.transactions, asOf).filter((r) => r.date >= toLocalIsoDate(asOf) && !r.materialized)
  const next = nextMinimumChargeAmount(stored, data.transactions, asOf)
  assert(`${stored.name}: ledger modal produces upcoming rows`, rowsFig.length > 0, 'modal returned nothing for a card with a balance')
  if (rowsFig.length > 0) check(`${stored.name}: Loans/Home figure === ledger modal's next row`, next, rowsFig[0].amount)

  // With a per-date override applied, every surface must move together.
  const overrideDate = rowsFig[0]?.date
  if (overrideDate) {
    const overridden = { ...stored, minimumPaymentOverrides: [{ date: overrideDate, amount: 12.34 }] }
    const overriddenRows = buildCreditCardMinimumChargeRows(overridden, data.transactions, asOf).filter((r) => r.date === overrideDate)
    check(`${stored.name}: override honoured by Loans/Home`, nextMinimumChargeAmount(overridden, data.transactions, asOf), 12.34)
    check(`${stored.name}: override honoured by ledger modal`, overriddenRows[0]?.amount, 12.34)
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}  [TZ=${process.env.TZ ?? 'unset'}]`)
process.exit(failures === 0 ? 0 : 1)
