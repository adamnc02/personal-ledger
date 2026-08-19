// Credit card calculations. Two different kinds of function live here,
// deliberately kept separate:
//  - PURE, non-mutating schedule generation (generateMinimumPaymentTransactions)
//    — same "compute what should exist, caller dedupes" contract as
//    schedule.ts / ledgerLoans.ts. These produce PENDING transactions and
//    do NOT touch currentBalance directly — that happens later, uniformly,
//    via applyClearSideEffects once a transaction actually clears (see
//    clearTransaction.ts and autoClear.ts).
//  - RECORDING functions (recordCreditCardSpend, recordCreditCardLumpPayment)
//    for things the user is telling the app already happened. Spend
//    increases currentBalance immediately regardless of cleared/pending
//    status (matches how a real card issuer posts a charge before it
//    "clears" in the bank-statement sense) — payments do NOT touch the
//    balance immediately; that's deferred to applyClearSideEffects too,
//    same as the generated minimum payment, so a future-dated logged
//    payment doesn't reduce the balance before its date actually arrives.

import { nanoid } from 'nanoid'
import { CREDIT_CARD_CATEGORY_ID, CREDIT_CARD_COLORS, type CreditCard, type CreditCardLumpPayment, type Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso } from './date'

/**
 * The monthly rate that compounds to the given APR over a year — NOT a
 * simple APR/12 division, which understates it. E.g. 22.9% APR compounds
 * from a monthly rate of ~1.73%, not 22.9/12 ≈ 1.91% (division actually
 * overstates the simple case, but the two diverge either direction
 * depending on the rate — the point is APR/12 isn't the right monthly
 * figure either way; this is the rate that genuinely compounds back to
 * the stated APR across 12 months).
 */
export function monthlyInterestRate(interestRatePercent: number): number {
  return Math.pow(1 + interestRatePercent / 100, 1 / 12) - 1
}

/** One cycle's interest, applied to a balance. Deliberately simplified — no daily accrual, no interest-free grace period on new purchases, interest just compounds monthly against whatever the balance is at each billing cycle. Same "clearly-scoped approximation" philosophy as the tax engine's own documented simplifications elsewhere in this app. */
export function applyMonthlyInterest(balance: number, interestRatePercent: number): number {
  if (balance <= 0) return balance
  return round2(balance * (1 + monthlyInterestRate(interestRatePercent)))
}

/**
 * The minimum payment for a GIVEN balance — the pure calculation shared
 * by both the "what's due right now" single-point query below and the
 * forward-simulating generator further down (and, via simulateCardPayoffMonths,
 * the What-if page's card payoff/overpayment simulation).
 */
export function minimumPaymentForBalance(minimumPayment: CreditCard['minimumPayment'], balance: number): number {
  if (balance <= 0) return 0
  if (minimumPayment.type === 'fixed') return round2(Math.min(minimumPayment.amount, balance))
  return round2((balance * minimumPayment.percent) / 100)
}

/**
 * The amount due for this cycle, computed fresh against the card's
 * CURRENT balance — never cached. For percent_of_balance cards this is
 * exactly why: 5% of a shrinking balance shrinks in turn each cycle, so
 * caching the £ figure from an earlier cycle would silently go stale.
 *
 * Interest for the UPCOMING cycle is applied first, before the minimum
 * is calculated — real statements work the same way: interest posts to
 * the balance, THEN the minimum payment is calculated against that new,
 * interest-inflated statement balance. currentBalance itself already
 * reflects every PAST cycle's interest (applied when each prior payment
 * cleared, see applyClearSideEffects in clearTransaction.ts) — this one
 * extra application projects one cycle further, for the payment that
 * hasn't happened yet.
 */
export function computeMinimumPaymentAmount(card: CreditCard): number {
  const balanceWithInterest = applyMonthlyInterest(card.currentBalance, card.interestRatePercent)
  return minimumPaymentForBalance(card.minimumPayment, balanceWithInterest)
}

/**
 * Generates pending credit_card_payment transactions for the given
 * card's payment day, one per month in the range — genuinely SIMULATING
 * the balance forward month by month, rather than computing every
 * month's amount against a single static snapshot (which silently broke
 * compounding whenever more than one month was generated in the same
 * call: a percent-of-balance card would show the exact same minimum for
 * every future month instead of shrinking).
 *
 * Also accounts for any logged lump payment dated before a given
 * month's payment date — a repayment logged for the 20th genuinely
 * reduces what the NEXT minimum payment is calculated against, even
 * before that repayment has itself cleared. Only lump payments that
 * HAVEN'T cleared yet (dated after today) are folded into the
 * simulation — anything already cleared is already reflected in
 * card.currentBalance, the simulation's starting point, and re-applying
 * it here would double-count it.
 */
export function generateMinimumPaymentTransactions(card: CreditCard, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  if (!card.active) return []
  const results: Omit<Transaction, 'id'>[] = []

  const today = toIso(new Date())
  let workingBalance = card.currentBalance
  const pendingLumpPayments = card.lumpPayments.filter((lp) => lp.date > today).sort((a, b) => a.date.localeCompare(b.date))
  let lumpIndex = 0

  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
  while (cursor <= rangeEnd) {
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const paymentDate = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(card.paymentDayOfMonth, daysInMonth))
    const paymentDateIso = toIso(paymentDate)

    // Interest for this cycle posts first, against the balance as it
    // stood going into the cycle — THEN any lump payments logged within
    // it reduce the balance, THEN the minimum is calculated against
    // what's left. This slightly overstates interest if a lump payment
    // landed early in the cycle (no daily precision here), which is a
    // deliberate, conservative simplification rather than an attempt at
    // exact accrual.
    workingBalance = applyMonthlyInterest(workingBalance, card.interestRatePercent)

    // Apply any still-pending lump payments dated on/before this
    // payment date, in date order, BEFORE computing this month's
    // minimum — this is what makes a repayment logged ahead of the next
    // charge date actually count toward it.
    while (lumpIndex < pendingLumpPayments.length && pendingLumpPayments[lumpIndex].date <= paymentDateIso) {
      workingBalance = round2(Math.max(0, workingBalance - pendingLumpPayments[lumpIndex].amount))
      lumpIndex++
    }

    if (paymentDate >= rangeStart && paymentDate <= rangeEnd) {
      // A per-date override (credit card ledger modal — "tap a row to
      // adjust") takes precedence over the computed figure, but still
      // feeds into workingBalance below exactly like a computed one
      // would, so later periods' compounding reflects the edit rather
      // than silently reverting to the un-overridden trajectory next
      // month.
      const override = card.minimumPaymentOverrides?.find((o) => o.date === paymentDateIso)
      const amount = override ? override.amount : minimumPaymentForBalance(card.minimumPayment, workingBalance)
      if (amount > 0) {
        results.push({
          date: paymentDateIso,
          amount,
          direction: 'out',
          // Deliberately the fixed builtin Credit Card category, NOT
          // card.categoryId — unlike a logged spend or lump payment
          // (which carry the card's own real, freely-assignable
          // category), the generated minimum-charge payment is always
          // hardcoded to Credit Card so it reads unambiguously as "this
          // card's minimum" in the category view, distinct from whatever
          // category the card itself has been given for its own icon.
          categoryId: CREDIT_CARD_CATEGORY_ID,
          paymentMethod: 'direct_debit',
          status: 'pending',
          type: 'credit_card_payment',
          location: 'personal',
          ownerId: card.ownerId,
          creditCardId: card.id,
          // The card's own name, with "Minimum Charge" appended — without
          // this suffix, a row would show only the card's name, which
          // reads identically to a logged lump payment against the same
          // card once both sit together in the Credit Card group.
          note: `${card.name} - Minimum Charge`,
        })
        workingBalance = round2(Math.max(0, workingBalance - amount))
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }
  return results
}

/**
 * Logs a purchase charged to this card, right now. Increases
 * currentBalance immediately and does NOT touch the personal ledger at
 * all (per the confirmed design — see the long comment on TransactionType
 * in types/ledger.ts). status is 'cleared' unless the date is in the
 * future, matching the same date-based heuristic used for other ad-hoc
 * ledger entries.
 */
export function recordCreditCardSpend(
  card: CreditCard,
  amount: number,
  date: string,
  note?: string,
): { updatedCard: CreditCard; transaction: Omit<Transaction, 'id'> } {
  const updatedCard: CreditCard = { ...card, currentBalance: round2(card.currentBalance + amount) }
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount,
    direction: 'out',
    categoryId: card.categoryId,
    paymentMethod: 'card',
    status: date <= toIso(new Date()) ? 'cleared' : 'pending',
    type: 'credit_card_spend',
    location: 'personal',
    ownerId: card.ownerId,
    creditCardId: card.id,
    note,
  }
  return { updatedCard, transaction }
}

/**
 * Logs an ad-hoc/lump payment toward this card — reduces currentBalance
 * immediately (clamped to zero) and produces the matching cash-out
 * transaction that DOES appear as a negative amount on the Personal
 * card, same as any other payment against the card.
 */
/**
 * Logs an ad-hoc/lump payment toward this card. Doesn't touch
 * currentBalance directly — that's applyClearSideEffects's job now,
 * applied immediately by the caller if the date is today/past, or later
 * by the automatic date-based clearing pass if it's a future date. Only
 * the LumpPayment log record itself is added right away, regardless of
 * date — that's just "you told the app about this payment," not a
 * balance effect.
 */
export function recordCreditCardLumpPayment(
  card: CreditCard,
  amount: number,
  date: string,
  note?: string,
): { updatedCard: CreditCard; transaction: Omit<Transaction, 'id'>; lumpPayment: CreditCardLumpPayment } {
  const lumpPayment: CreditCardLumpPayment = { id: nanoid(8), date, amount, note }
  const updatedCard: CreditCard = {
    ...card,
    lumpPayments: [...card.lumpPayments, lumpPayment],
  }
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount,
    direction: 'out',
    categoryId: card.categoryId,
    paymentMethod: 'bank_transfer',
    status: date <= toIso(new Date()) ? 'cleared' : 'pending',
    type: 'credit_card_payment',
    location: 'personal',
    ownerId: card.ownerId,
    creditCardId: card.id,
    sourceType: 'credit_card_lump_payment',
    sourceId: lumpPayment.id,
    note,
  }
  return { updatedCard, transaction, lumpPayment }
}

/**
 * How many months until this card would be paid off making only the
 * minimum payment plus an optional fixed extra amount every month — used
 * by the What-if page to compare "as things stand" against a hypothetical
 * lump sum or recurring overpayment, the credit-card equivalent of a
 * loan's buildLoanSchedule/summarizeLoan. Genuinely simulates month by
 * month (interest compounds, and a percent-of-balance minimum shrinks as
 * the balance does) rather than a closed-form estimate — same reasoning
 * as generateMinimumPaymentTransactions above. Capped at 600 months (50
 * years) as a safety net against a balance that never reaches zero (e.g.
 * a fixed minimum smaller than the interest accruing against it).
 */
export function simulateCardPayoffMonths(card: CreditCard, extraPerMonth = 0, maxMonths = 600): { months: number; totalInterestPaid: number } {
  let balance = card.currentBalance
  let totalInterestPaid = 0
  let months = 0

  while (balance > 0 && months < maxMonths) {
    const balanceAfterInterest = applyMonthlyInterest(balance, card.interestRatePercent)
    totalInterestPaid = round2(totalInterestPaid + round2(balanceAfterInterest - balance))
    const payment = Math.min(balanceAfterInterest, round2(minimumPaymentForBalance(card.minimumPayment, balanceAfterInterest) + extraPerMonth))
    // A payment of £0 (e.g. minimum payment rounds to nothing on a tiny
    // balance, and there's no extra) would loop forever — bail out rather
    // than spin to maxMonths for a balance that's genuinely never going to
    // clear under these terms.
    if (payment <= 0) break
    balance = round2(Math.max(0, balanceAfterInterest - payment))
    months++
  }

  return { months, totalInterestPaid }
}

/** Round-robins through CREDIT_CARD_COLORS by however many cards already exist — same auto-assignment idea as pickColorForIndex in categories.ts, but on the separate palette described in types/ledger.ts. */
export function pickCreditCardColor(existingCount: number): string {
  return CREDIT_CARD_COLORS[existingCount % CREDIT_CARD_COLORS.length]
}

/** Total paid to date against this card — the "paid" half of the card page's pie chart (doc addendum). Sums credit_card_payment transactions for this card from the full transaction list, since payments aren't tracked as a running total on the CreditCard itself. */
/** Total ACTUALLY paid to date against this card — the "paid" half of the card page's pie chart. Only counts CLEARED payments; a pending future-dated one (logged but not yet due) hasn't actually been paid yet and must not count, even though it already exists as a transaction. */
export function totalPaidForCard(cardId: string, transactions: Transaction[]): number {
  return round2(
    transactions
      .filter((t) => t.type === 'credit_card_payment' && t.creditCardId === cardId && t.status === 'cleared')
      .reduce((sum, t) => sum + t.amount, 0),
  )
}

export interface CreditCardMinimumChargeRow {
  date: string
  amount: number
  status: 'cleared' | 'pending'
  // Whether this row already exists as a real, stored Transaction — an
  // edit to a materialized row updates that transaction directly; an
  // edit to a non-materialized (still just generated/projected) row
  // writes to card.minimumPaymentOverrides instead. Both cases are
  // handled transparently by LedgerContext's updateCreditCardMinimumCharge
  // — this flag exists purely so the UI can show a subtle "already
  // happened" vs "projected" distinction if it wants to, not because the
  // edit flow itself needs the caller to know which path it'll take.
  materialized: boolean
}

/**
 * Every minimum-charge row for this card's ledger modal (Loans.tsx) —
 * deliberately ONLY minimum charges, never spend or lump payments, which
 * already have a full ledger on the card's own Home page detail view.
 * Combines real stored transactions (materialized: true) with generated
 * projections for anything not yet materialized, de-duplicated by date —
 * a stored transaction always wins over a generated one for the same
 * date, since it's the authoritative real record.
 */
export function buildCreditCardMinimumChargeRows(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCardMinimumChargeRow[] {
  const todayIso = toIso(asOfDate)
  const stored = transactions.filter((t) => t.creditCardId === card.id && t.type === 'credit_card_payment' && !t.sourceType)
  const storedDates = new Set(stored.map((t) => t.date))

  // Confirmed as a real bug: a blind "1 year back" was generating a full
  // year of entirely fictional past minimum charges for a BRAND NEW
  // card with no real payment history at all — nothing to show, since
  // the card didn't exist that far back, but the modal generated rows
  // for it anyway, burying "today onward" a year of scrolling deep.
  // CreditCard has no real "created"/start date to anchor to, so the
  // honest fix is: only look as far back as there's real DATA to
  // justify it. A card with genuine stored history shows back to its
  // own earliest real transaction (so anything actually there stays
  // editable) — a fresh card with none shows nothing before today at
  // all, rather than a year of rows that never happened.
  const earliestStoredMs = stored.length > 0 ? Math.min(...stored.map((t) => new Date(t.date).getTime())) : asOfDate.getTime()
  const rangeStart = new Date(Math.min(earliestStoredMs, asOfDate.getTime()))
  const rangeEnd = new Date(asOfDate.getFullYear() + 2, asOfDate.getMonth(), 1)
  const generated = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd).filter((t) => !storedDates.has(t.date))

  const rows: CreditCardMinimumChargeRow[] = [
    ...stored.map((t) => ({ date: t.date, amount: t.amount, status: t.status, materialized: true })),
    ...generated.map((t) => ({ date: t.date, amount: t.amount, status: t.date <= todayIso ? ('cleared' as const) : ('pending' as const), materialized: false })),
  ]
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}
