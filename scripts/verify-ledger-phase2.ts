import { generateTransactionsForTemplate, newRecurringTemplate } from '../src/lib/schedule'
import { buildLoanSchedule, summarizeLoan, applyLoanOverpayment, nominalTotalPayable, generateLoanPaymentTransactions } from '../src/lib/ledgerLoans'
import { computeMinimumPaymentAmount, generateMinimumPaymentTransactions, recordCreditCardSpend, recordCreditCardLumpPayment, totalPaidForCard } from '../src/lib/creditCards'
import { applyClearSideEffects } from '../src/lib/clearTransaction'
import { summarizeByPaymentMethod } from '../src/lib/paymentMethodSummary'
import { CREDIT_CARD_CATEGORY_ID } from '../src/types/ledger'
import type { CreditCard, Loan, Transaction } from '../src/types/ledger'

let failures = 0
const round2 = (n: number) => Math.round(n * 100) / 100
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. Recurring template schedule generation ----
const monthlyRent = newRecurringTemplate({
  name: 'Rent',
  amount: 900,
  categoryId: 'home',
  paymentMethod: 'standing_order',
  frequency: 'monthly',
  anchorDate: '2026-01-31', // day 31 — should clamp in shorter months
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
})
const rentOccurrences = generateTransactionsForTemplate(monthlyRent, new Date(2026, 0, 1), new Date(2026, 3, 30)).map((t) => t.date)
check('Monthly rent (anchor day 31) generates Jan–Apr, clamped in Feb/Apr', rentOccurrences, [
  '2026-01-31',
  '2026-02-28', // 2026 is not a leap year
  '2026-03-31',
  '2026-04-30',
])

const fortnightly = newRecurringTemplate({
  name: 'Cleaner',
  amount: 40,
  categoryId: 'maintenance',
  paymentMethod: 'bank_transfer',
  frequency: 'every_n_weeks',
  intervalWeeks: 2,
  anchorDate: '2026-06-01',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
})
const fortnightlyOccurrences = generateTransactionsForTemplate(fortnightly, new Date(2026, 5, 1), new Date(2026, 6, 31)).map((t) => t.date)
check('Every-2-weeks template generates the expected dates', fortnightlyOccurrences, [
  '2026-06-01',
  '2026-06-15',
  '2026-06-29',
  '2026-07-13',
  '2026-07-27',
])

const paused = newRecurringTemplate({
  name: 'Paused gym',
  amount: 30,
  categoryId: 'fitness',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
})
paused.active = false
check('An inactive template generates nothing', generateTransactionsForTemplate(paused, new Date(2026, 0, 1), new Date(2026, 11, 31)).length, 0)

// ---- 2. Loan schedule + native overpayments ----
const loan: Loan = {
  id: 'loan-1',
  name: 'Car finance',
  monthlyPayment: 250,
  termMonths: 12,
  startDate: '2026-01-15',
  categoryId: 'car',
  location: 'personal',
  ownerId: 'me',
  payee: 'me',
  payeeSharePercent: 100,
  overpayments: [],
}
check('nominalTotalPayable = monthly × term', nominalTotalPayable(loan), 3000)

const schedule = buildLoanSchedule(loan)
check('12-month loan produces exactly 12 schedule entries with no overpayments', schedule.length, 12)
check('Final balance reaches exactly zero', schedule.at(-1)?.balanceAfter, 0)
check('First payment date matches startDate', schedule[0].date, '2026-01-15')

const { updatedLoan, transaction: overpaymentTxn } = applyLoanOverpayment(loan, 1000, '2026-03-20', 'Bonus overpayment')
const scheduleWithOverpayment = buildLoanSchedule(updatedLoan)
check('A £1000 overpayment in month 3 shortens the schedule below 12 months', scheduleWithOverpayment.length < 12, true)
check('Overpayment is applied in the March entry, not April', scheduleWithOverpayment[2].overpaymentApplied, 1000)
check('Overpayment transaction is a cleared loan_payment', overpaymentTxn.status, 'cleared')
check('Overpayment transaction links back via sourceType', overpaymentTxn.sourceType, 'loan_overpayment')

const summary = summarizeLoan(updatedLoan, new Date(2026, 1, 1)) // as-of 1 Feb, before the overpayment lands
check('summarizeLoan as-of Feb 1 (before overpayment) has monthsRemaining reflecting the shorter post-overpayment schedule', summary.monthsRemaining, scheduleWithOverpayment.filter((e) => e.date > '2026-02-01').length)

// ---- 3. Credit card minimum payment + compounding percent ----
// interestRatePercent: 0 — this test group is about the percent-of-balance
// mechanic itself, isolated from interest (which has its own dedicated
// test group further down).
const card: CreditCard = {
  id: 'card-1',
  name: 'Amex',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  color: '#8b5cf6',
  interestRatePercent: 0,
  currentBalance: 1000,
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 10,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}
check('5% of £1000 balance', computeMinimumPaymentAmount(card), 50)

const cardAfterSpend = recordCreditCardSpend(card, 200, '2026-06-01').updatedCard
check('Spend increases currentBalance', cardAfterSpend.currentBalance, 1200)
check('5% minimum payment recalculates against the NEW higher balance, not cached', computeMinimumPaymentAmount(cardAfterSpend), 60)

// recordCreditCardLumpPayment no longer reduces the balance itself — that's
// applyClearSideEffects's job now, applied by the caller once the payment
// actually clears (immediately for a same-day one, like this test's).
const lumpResult = recordCreditCardLumpPayment(cardAfterSpend, 60, '2026-06-10')
check('recordCreditCardLumpPayment alone does NOT reduce the balance — that only happens once the payment clears', lumpResult.updatedCard.currentBalance, 1200)
const cardAfterMinPayment = applyClearSideEffects(
  { people: [], categories: [], recurringTemplates: [], loans: [], creditCards: [lumpResult.updatedCard], transactions: [], payCycles: [], scenarios: [], primaryPersonId: '' },
  { ...lumpResult.transaction, id: 'tx-1' },
).creditCards[0]
check('Once cleared (via applyClearSideEffects), paying the minimum reduces the balance', cardAfterMinPayment.currentBalance, 1140)
check('Next cycle\'s 5% minimum is now LOWER than the previous cycle\'s (compounds down as balance shrinks)', computeMinimumPaymentAmount(cardAfterMinPayment) < 60, true)
check('Specifically, 5% of the new £1140 balance', computeMinimumPaymentAmount(cardAfterMinPayment), 57)

const fixedCard: CreditCard = { ...card, id: 'card-2', minimumPayment: { type: 'fixed', amount: 25 } }
check('Fixed minimum payment ignores balance entirely', computeMinimumPaymentAmount(fixedCard), 25)
const nearlyPaidOffCard: CreditCard = { ...fixedCard, currentBalance: 10 }
check('Fixed minimum payment never exceeds the remaining balance', computeMinimumPaymentAmount(nearlyPaidOffCard), 10)

const spendResult = recordCreditCardSpend(card, 50, '2026-06-01')
check('credit_card_spend transaction never touches location/ownerId inconsistently — stays personal', spendResult.transaction.location, 'personal')
check('credit_card_spend gets the reserved built-in category', spendResult.transaction.categoryId, CREDIT_CARD_CATEGORY_ID)

const generatedPayments = generateMinimumPaymentTransactions(card, new Date(2026, 0, 1), new Date(2026, 2, 31))
check('3 months of generated minimum payments (Jan/Feb/Mar), all pending', generatedPayments.every((t) => t.status === 'pending'), true)
check('Generated minimum payments do not include a sourceId (not linked to a specific lump payment)', generatedPayments.every((t) => t.sourceId === undefined), true)

const { transaction: lumpTxn } = recordCreditCardLumpPayment(card, 500, '2026-06-15', 'Paid off half')
check('Lump payment transaction is negative-sign eligible (direction out) so it shows on the Personal card', lumpTxn.direction, 'out')
check('Lump payment transaction links to the specific lump payment record', typeof lumpTxn.sourceId, 'string')

const paidSoFar = totalPaidForCard('card-1', [
  { ...lumpTxn, id: 'x1' } as Transaction,
  { ...lumpTxn, id: 'x2', amount: 100 } as Transaction,
  { ...spendResult.transaction, id: 'x3' } as Transaction, // a spend — must NOT count as "paid"
])
check('totalPaidForCard sums only credit_card_payment transactions, excluding spend', paidSoFar, 600)

// ---- 4. Payment method summary ----
const txns: Transaction[] = [
  { id: '1', date: '2026-06-01', amount: 50, direction: 'out', categoryId: 'food', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
  { id: '2', date: '2026-06-02', amount: 30, direction: 'out', categoryId: 'food', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
  { id: '3', date: '2026-06-03', amount: 900, direction: 'out', categoryId: 'home', paymentMethod: 'standing_order', status: 'cleared', type: 'bill_payment', location: 'personal', ownerId: 'me' },
  { id: '4', date: '2026-06-04', amount: 2000, direction: 'in', categoryId: 'income', paymentMethod: 'bank_transfer', status: 'cleared', type: 'salary', location: 'personal', ownerId: 'me' },
]
const byMethod = summarizeByPaymentMethod(txns)
check('3 distinct payment methods used in the sample (cash, direct_debit unused -> excluded)', byMethod.length, 3)
const cardRow = byMethod.find((r) => r.paymentMethod === 'card')
check('Card total is the two card expenses combined, negative', cardRow?.total, -80)
check('Card count is 2', cardRow?.count, 2)
const bankTransferRow = byMethod.find((r) => r.paymentMethod === 'bank_transfer')
check('Bank transfer total is positive (salary, direction in)', bankTransferRow?.total, 2000)

// ---- 5. Recurring overpayments ----
const loanWithFixedRecurring: Loan = {
  ...loan,
  recurringOverpayment: { startDate: '2026-02-01', amount: { type: 'fixed', amount: 100 } },
}
const fixedSchedule = buildLoanSchedule(loanWithFixedRecurring)
check('No recurring overpayment applied in month 1 (before its startDate)', fixedSchedule[0].recurringOverpaymentApplied, 0)
check('£100 fixed recurring overpayment applied from month 2 onward', fixedSchedule[1].recurringOverpaymentApplied, 100)
check('Fixed recurring overpayment shortens the loan below the original 12 months', fixedSchedule.length < 12, true)

const loanWithPercentRecurring: Loan = {
  ...loan,
  recurringOverpayment: { startDate: '2026-01-15', amount: { type: 'percent_of_balance', percent: 10 } },
}
const percentSchedule = buildLoanSchedule(loanWithPercentRecurring)
check('10% recurring overpayment in month 1 is 10% of the POST-scheduled-payment balance (£2750 → £275)', percentSchedule[0].recurringOverpaymentApplied, 275)
check(
  'Month 2\'s 10% recurring overpayment is smaller than month 1\'s — recalculated against the now-lower balance, not cached',
  percentSchedule[1].recurringOverpaymentApplied < percentSchedule[0].recurringOverpaymentApplied,
  true,
)

const loanWithEndDate: Loan = {
  ...loan,
  recurringOverpayment: { startDate: '2026-01-15', endDate: '2026-02-28', amount: { type: 'fixed', amount: 50 } },
}
const endDateSchedule = buildLoanSchedule(loanWithEndDate)
check('Recurring overpayment applies within its window (month 1)', endDateSchedule[0].recurringOverpaymentApplied, 50)
check('Recurring overpayment applies within its window (month 2)', endDateSchedule[1].recurringOverpaymentApplied, 50)
check('Recurring overpayment stops applying once past its endDate (month 3)', endDateSchedule[2]?.recurringOverpaymentApplied ?? 0, 0)

const recurringTxns = generateLoanPaymentTransactions(loanWithFixedRecurring, new Date(2026, 1, 1), new Date(2026, 1, 28))
check("The recurring overpayment is folded into the SAME monthly transaction, not a separate line", recurringTxns.length, 1)
check('That transaction\'s amount includes both the scheduled payment and the recurring overpayment', recurringTxns[0].amount, 350) // 250 scheduled + 100 recurring
check('The transaction carries a note explaining the recurring overpayment is included', recurringTxns[0].note?.includes('recurring overpayment'), true)

const oneOffOverpaymentTxn = applyLoanOverpayment(loan, 500, '2026-03-20').transaction
check('A one-off logged overpayment is STILL its own separate transaction, unaffected by the recurring-overpayment folding change', oneOffOverpaymentTxn.amount, 500)

// ---- 6. Credit card minimum payments genuinely compound across MULTIPLE months in a single generation call ----
// The reported bug: generateMinimumPaymentTransactions used to compute
// every month's amount from one static balance snapshot, so a
// percent-of-balance card showed the exact same figure for every future
// month instead of shrinking.
// interestRatePercent: 0 here deliberately — this test group is
// specifically about compounding driven by the MINIMUM PAYMENTS
// themselves across multiple months, isolated from interest (which has
// its own dedicated test group below).
const compoundingCard: CreditCard = {
  id: 'card-compound', name: 'Amex', categoryId: CREDIT_CARD_CATEGORY_ID, color: '#8b5cf6',
  interestRatePercent: 0, currentBalance: 500,
  minimumPayment: { type: 'percent_of_balance', percent: 5 },
  paymentDayOfMonth: 6, ownerId: 'me', lumpPayments: [], active: true,
}
const threeMonthsNoRepayment = generateMinimumPaymentTransactions(compoundingCard, new Date(2026, 7, 1), new Date(2026, 9, 31))
check('3 months generated in one call, no repayment', threeMonthsNoRepayment.length, 3)
check('Month 1: 5% of £500', threeMonthsNoRepayment[0].amount, 25)
check('Month 2: 5% of £475 (compounds down from month 1, NOT the same static £25 again)', threeMonthsNoRepayment[1].amount, 23.75)
check('Month 3: 5% of £451.25 (continues compounding)', threeMonthsNoRepayment[2].amount, 22.56)
check('The generated transaction carries the card\'s own name as its note (not just falling back to the Credit Card category)', threeMonthsNoRepayment[0].note, 'Amex')

// A lump payment logged for a date BEFORE the next minimum-payment date
// (but still in the future relative to "today") must be folded into
// that next minimum's calculation.
const { updatedCard: cardWithFutureRepayment } = recordCreditCardLumpPayment(compoundingCard, 100, '2026-08-20')
const withRepayment = generateMinimumPaymentTransactions(cardWithFutureRepayment, new Date(2026, 7, 1), new Date(2026, 9, 31))
check('Month 1 (before the repayment date) is unaffected: still 5% of £500', withRepayment[0].amount, 25)
check('Month 2 (after the repayment): 5% of (500 - 25 - 100) = 5% of £375', withRepayment[1].amount, 18.75)
check('Month 3 continues compounding from the post-repayment balance', withRepayment[2].amount, round2(0.05 * (375 - 18.75)))

// A lump payment dated AFTER the horizon being generated must not be applied early.
const { updatedCard: cardWithFarFutureRepayment } = recordCreditCardLumpPayment(compoundingCard, 100, '2026-11-15')
const beforeThatRepayment = generateMinimumPaymentTransactions(cardWithFarFutureRepayment, new Date(2026, 7, 1), new Date(2026, 9, 31))
check('A lump payment dated after the generated range does not affect any of these months', beforeThatRepayment.map((t) => t.amount), threeMonthsNoRepayment.map((t) => t.amount))

// An ALREADY-CLEARED lump payment (dated in the past) must NOT be re-applied — it's already reflected in currentBalance.
const alreadyClearedCard: CreditCard = { ...compoundingCard, currentBalance: 400, lumpPayments: [{ id: 'lp-1', date: '2026-01-01', amount: 100 }] }
const withAlreadyClearedLump = generateMinimumPaymentTransactions(alreadyClearedCard, new Date(2026, 7, 1), new Date(2026, 7, 31))
check('An already-cleared (past-dated) lump payment is NOT re-subtracted — currentBalance already reflects it', withAlreadyClearedLump[0].amount, 20) // 5% of 400, not 5% of 300

// ---- 7. Interest rate — genuinely used now, not just a stored, ignored field ----
import { monthlyInterestRate } from '../src/lib/creditCards'

check('monthlyInterestRate compounds correctly: 22.9% APR -> ~1.7332%/month (NOT the naive 22.9/12 = 1.9083%)', monthlyInterestRate(22.9) * 100, 1.7332, 0.001)
check('0% APR has a 0% monthly rate', monthlyInterestRate(0), 0)

const interestCard: CreditCard = { ...card, id: 'card-interest', currentBalance: 500, interestRatePercent: 22.9, minimumPayment: { type: 'percent_of_balance', percent: 5 }, paymentDayOfMonth: 15 }
check("computeMinimumPaymentAmount includes one cycle's interest, so it's MORE than the naive 5% of 500 (£25)", computeMinimumPaymentAmount(interestCard) > 25, true)
check('Specifically £25.43 (5% of £500 after one month of 22.9% APR interest)', computeMinimumPaymentAmount(interestCard), 25.43)

const interestSchedule = generateMinimumPaymentTransactions(interestCard, new Date(2026, 7, 1), new Date(2026, 9, 30))
check('3-month interest-bearing schedule: month 1', interestSchedule[0].amount, 25.43)
check('3-month interest-bearing schedule: month 2', interestSchedule[1].amount, 24.58)
check('3-month interest-bearing schedule: month 3', interestSchedule[2].amount, 23.76)

// A 0% interest card must behave EXACTLY as before this change — pure regression safety.
const zeroInterestCard: CreditCard = { ...interestCard, id: 'card-zero-interest', interestRatePercent: 0 }
const zeroInterestSchedule = generateMinimumPaymentTransactions(zeroInterestCard, new Date(2026, 7, 1), new Date(2026, 9, 30))
check('0% interest: month 1 is exactly 5% of £500, unaffected by the interest feature', zeroInterestSchedule[0].amount, 25)
check('0% interest: month 2 is exactly 5% of £475 (pure payment-driven compounding only)', zeroInterestSchedule[1].amount, 23.75)

// The debt-trap property: a fixed minimum payment smaller than the
// interest accruing each cycle means the balance genuinely GROWS over
// time despite payments being made — the real, important mechanic of
// minimum-payment-only credit card debt.
const debtTrapCard: CreditCard = { ...card, id: 'card-debt-trap', currentBalance: 500, interestRatePercent: 29.9, minimumPayment: { type: 'fixed', amount: 5 }, paymentDayOfMonth: 15 }
let debtTrapData: AppDataV2 = { people: [], categories: [], recurringTemplates: [], loans: [], creditCards: [debtTrapCard], transactions: [], payCycles: [], scenarios: [], primaryPersonId: '' }
const debtTrapSchedule = generateMinimumPaymentTransactions(debtTrapCard, new Date(2026, 7, 1), new Date(2027, 1, 28))
for (const t of debtTrapSchedule) {
  debtTrapData = applyClearSideEffects(debtTrapData, { ...t, id: 'debt-trap-' + t.date })
}
check(
  "A £5/month fixed minimum on a 29.9% APR card doesn't cover the interest — the balance GROWS over 7 months of payments, from £500 to over £540",
  debtTrapData.creditCards[0].currentBalance > 540,
  true,
)

// Interest is tied to the GENERATED minimum payment (the billing-cycle
// event) specifically, NOT to an arbitrary logged lump payment — a lump
// payment clearing must reduce the balance without also triggering a
// full cycle's interest.
const lumpOnlyCard: CreditCard = { ...card, id: 'card-lump-only', currentBalance: 500, interestRatePercent: 22.9 }
const lumpOnlyTxn = { date: '2026-08-15', amount: 100, direction: 'out' as const, categoryId: 'category-credit-card', paymentMethod: 'bank_transfer' as const, status: 'cleared' as const, type: 'credit_card_payment' as const, location: 'personal' as const, ownerId: 'me', creditCardId: 'card-lump-only', sourceType: 'credit_card_lump_payment' as const, sourceId: 'lump-1', id: 'tx-lump' }
const afterLumpOnly = applyClearSideEffects({ people: [], categories: [], recurringTemplates: [], loans: [], creditCards: [lumpOnlyCard], transactions: [], payCycles: [], scenarios: [], primaryPersonId: '' }, lumpOnlyTxn)
check('A lump payment clearing reduces the balance by exactly its amount, with NO interest applied (500 - 100 = 400, not 500×interest - 100)', afterLumpOnly.creditCards[0].currentBalance, 400)

// ---- 8. totalPaidForCard correctly excludes pending (not-yet-actually-paid) transactions ----
const pendingOnlyTxn: Transaction = { id: 'tx-pending', date: '2026-09-06', amount: 100, direction: 'out', categoryId: CREDIT_CARD_CATEGORY_ID, paymentMethod: 'bank_transfer', status: 'pending', type: 'credit_card_payment', location: 'personal', ownerId: 'me', creditCardId: 'card-1' }
check('A PENDING (not yet due) payment does NOT count toward totalPaidForCard, even though it exists as a transaction', totalPaidForCard('card-1', [pendingOnlyTxn]), 0)
const clearedOnlyTxn: Transaction = { ...pendingOnlyTxn, id: 'tx-cleared', status: 'cleared' }
check('A CLEARED payment does count', totalPaidForCard('card-1', [clearedOnlyTxn]), 100)


process.exit(failures === 0 ? 0 : 1)
