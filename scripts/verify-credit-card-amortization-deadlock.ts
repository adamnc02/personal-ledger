// UAT 2026-09-08 (8-bug9.2-minimum-charges-stop, retest of the earlier
// Batch 8 fix): Adam reproduced the same "perpetual sub-£0.02 minimum
// charge" symptom again after this session's NEGLIGIBLE_BALANCE fix had
// already landed — paying a card off in full on its due date, then
// logging a further overpayment, still left minimum charges of a few
// pence generating every month indefinitely.
//
// Root-caused as a DIFFERENT mechanism than the earlier fixed-point-near-
// zero bug: NEGLIGIBLE_BALANCE (£0.02) only snaps a balance that's
// ALREADY tiny. It never fires for a percent-of-balance minimum stuck on
// a small-but-not-tiny balance (well above £0.02) where the rounded
// minimum payment doesn't even cover the interest this cycle accrues —
// a genuine amortisation deadlock, not a near-zero rounding artefact.
// E.g. a 15% APR card with a 1%-of-balance minimum and a £0.49 balance:
// interest rounds the balance UP to £0.50, the 1% minimum rounds to
// exactly £0.01, and paying it leaves £0.49 — right back where the cycle
// started, forever, generating a real (if tiny) "Minimum Charge"
// transaction every single month.
//
// Fixed by comparing each cycle's post-payment balance against what the
// balance stood at BEFORE that cycle's interest was even applied: if the
// computed minimum wouldn't leave the balance any lower than that, the
// whole remaining balance is charged instead of the non-progressing
// minimum. Applied in both generateMinimumPaymentTransactions (the real
// generator behind every ledger/projection minimum-charge row) and
// computeMinimumPaymentAmount (the single-point "what's due" query).

// UAT 2026-09-08, second retest — Adam reproduced a DIFFERENT deadlock on
// a statement-window card (statementStartDay/statementEndDay set): a spend
// lands in the true running balance (workingBalance) immediately, but the
// figure the minimum is actually sized off (statementBalance) only picks
// it up once its own window closes — the two can permanently diverge, and
// workingBalance can deadlock on its own even while statementBalance is
// still (very slowly) shrinking, since the original guard only ever
// checked statementBalance. Exact repro: a card with statementStartDay 19/
// statementEndDay 18/paymentDayOfMonth 14, a £20 spend, then a same-amount
// overpayment — workingBalance got stuck oscillating at 60-61p forever
// (£0.60 minus a 1p minimum, regrown back to £0.61 by interest) while
// statementBalance alone crept down 1p/month, decades from zero. Fixed by
// checking BOTH balances' own before-interest progress, and paying off
// whichever is larger when either deadlocks.

import { generateMinimumPaymentTransactions, computeMinimumPaymentAmount, cardBalanceAsOf, recordCreditCardSpend, recordCreditCardLumpPayment } from '../src/lib/creditCards'
import type { CreditCard, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const deadlockedCard: CreditCard = {
  id: 'card-1',
  name: 'Deadlock Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 15,
  currentBalance: 0.49,
  balanceAsOfDate: '2026-01-14',
  minimumPayment: { type: 'percent_of_balance', percent: 1 },
  paymentDayOfMonth: 14,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}

// ---- 1. The generator must not keep producing charges for 5 years straight ----
const fiveYearsOfCharges = generateMinimumPaymentTransactions(deadlockedCard, new Date(2026, 0, 14), new Date(2031, 0, 14), [])
check('A deadlocked £0.49 balance does NOT generate 60 straight monthly minimum charges', fiveYearsOfCharges.length < 60, true)

// ---- 2. Whatever it DOES generate must actually resolve the debt, not just restate it ----
const totalCharged = Math.round(fiveYearsOfCharges.reduce((s, t) => s + t.amount, 0) * 100) / 100
check('The generated charge(s) pay off at least the original £0.49 (accounting for interest), not just a few pence', totalCharged >= 0.49, true)

// ---- 3. The replayed balance actually reaches, and stays at, £0 ----
const chargesAsTransactions = fiveYearsOfCharges.map((t, i) => ({ ...t, id: `gen-${i}`, status: 'cleared' as const }))
check('cardBalanceAsOf reaches exactly £0 once the deadlocked balance is resolved', cardBalanceAsOf(deadlockedCard, chargesAsTransactions, new Date(2031, 0, 14)), 0)

// ---- 4. computeMinimumPaymentAmount (the single-point query) has the same guard ----
check('computeMinimumPaymentAmount pays off the whole £0.50 (post-interest) rather than a non-progressing £0.01', computeMinimumPaymentAmount(deadlockedCard), 0.5)

// ---- 5a. The statement-window divergence repro ----
let windowCard: CreditCard = {
  id: 'card-2',
  name: 'Statement Window Visa',
  categoryId: 'cat-cc',
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 0,
  balanceAsOfDate: '2026-09-01',
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 14,
  statementStartDay: 19,
  statementEndDay: 18,
  ownerId: 'adam',
  lumpPayments: [],
  active: true,
}
let windowTransactions: (Omit<Transaction, 'id'> & { id: string })[] = []
const spend = recordCreditCardSpend(windowCard, 20, '2026-09-09', 'test spend')
windowCard = spend.updatedCard
windowTransactions.push({ ...spend.transaction, id: 't0' })
const overpay = recordCreditCardLumpPayment(windowCard, 20, '2026-10-14', 'overpayment')
windowCard = overpay.updatedCard
windowTransactions.push({ ...overpay.transaction, id: 't1' })

const windowCharges = generateMinimumPaymentTransactions(windowCard, new Date(2026, 8, 1), new Date(2031, 8, 1), windowTransactions)
check('A statement-window card with a matching overpayment does NOT generate 60 straight monthly minimum charges', windowCharges.length < 60, true)
const windowAllTx = [...windowTransactions, ...windowCharges.map((t, i) => ({ ...t, id: `gen-${i}`, status: 'cleared' as const }))]
check('...and its real balance reaches exactly £0', cardBalanceAsOf(windowCard, windowAllTx, new Date(2031, 8, 1)), 0)

// ---- 5b. Regression guard — a genuinely progressing percent-of-balance minimum is unaffected ----
const healthyCard: CreditCard = { ...deadlockedCard, currentBalance: 500, minimumPayment: { type: 'percent_of_balance', percent: 5 } }
check('A real £500 balance with a real 5% minimum still pays the computed minimum, not the full balance', computeMinimumPaymentAmount(healthyCard) < 500, true)

console.log(failures === 0 ? '\nAll credit-card amortisation-deadlock checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
