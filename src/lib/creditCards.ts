// Credit card calculations. Two different kinds of function live here,
// deliberately kept separate:
//  - PURE, non-mutating schedule generation (generateMinimumPaymentTransactions)
//    — same "compute what should exist, caller dedupes" contract as
//    schedule.ts / ledgerLoans.ts. These produce PENDING transactions and
//    do NOT touch currentBalance directly — that happens later, uniformly,
//    via applyClearSideEffects once a transaction actually clears (see
//    clearTransaction.ts and autoClear.ts).
//  - RECORDING functions (recordCreditCardSpend, recordCreditCardLumpPayment)
//    for things the user is telling the app already happened. NEITHER
//    of these writes to card.currentBalance any more — see below.
//
// THE BALANCE IS DERIVED, NOT STORED. card.currentBalance is a stated
// anchor as at card.balanceAsOfDate and is only ever changed by the
// person editing it. What the card owes right now comes from
// cardBalanceAsOf(), which replays interest and card activity forward
// from that anchor. See the comment on CreditCard in types/ledger.ts for
// the bug this replaced.

import { nanoid } from 'nanoid'
import { addDays } from 'date-fns'
import { CREDIT_CARD_CATEGORY_ID, CREDIT_CARD_COLORS, type CreditCard, type CreditCardLumpPayment, type Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso } from './date'

// BUGFIX (Batch 8, 2026-09-07, Bug 9.2, Adam-reported): a percent_of_balance
// minimum payment is mathematically a fraction of whatever's left, so a
// balance approaching zero shrinks GEOMETRICALLY (£0.79 -> £0.75 -> £0.71
// -> ...) rather than ever landing on exactly zero — round2 alone doesn't
// help, since each of those figures rounds to a perfectly normal-looking
// non-zero penny amount in its own right. Concretely: Adam logged a
// payment for the FULL balance due on the card's own payment day, which
// correctly zeroed the balance for that cycle — but the interest accrual
// due the NEXT cycle (a fraction of a still-technically-positive
// leftover) kept reintroducing a few pence, and a percent-of-balance
// minimum kept charging a few pence of THAT, forever, despite the card
// being genuinely "cleared" from a real person's point of view. Once a
// balance is this negligible, treat it as paid off outright — no further
// interest compounds on it, and no further minimum charge gets generated
// for it — rather than let the two rules perpetuate a shrinking-but-
// never-quite-zero trail indefinitely. Matches Adam's own "below £0.02"
// description of the residue exactly.
const NEGLIGIBLE_BALANCE = 0.02

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
  if (balance <= NEGLIGIBLE_BALANCE) return 0
  return round2(balance * (1 + monthlyInterestRate(interestRatePercent)))
}

/**
 * The minimum payment for a GIVEN balance — the pure calculation shared
 * by both the "what's due right now" single-point query below and the
 * forward-simulating generator further down (and, via simulateCardPayoffMonths,
 * the What-if page's card payoff/overpayment simulation).
 */
export function minimumPaymentForBalance(minimumPayment: CreditCard['minimumPayment'], balance: number): number {
  if (balance <= NEGLIGIBLE_BALANCE) return 0
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
  const computedMinimum = minimumPaymentForBalance(card.minimumPayment, balanceWithInterest)
  // UAT 2026-09-08 (8-bug9.2-minimum-charges-stop) — same amortisation-
  // deadlock guard as generateMinimumPaymentTransactions: if the computed
  // minimum wouldn't leave the balance any lower than it stood before
  // this cycle's interest, it's not keeping pace with interest — the
  // whole remaining balance is due instead of perpetuating a residue.
  // Restricted the same way, and for the same reason, as that function's
  // own guard: only when a percent_of_balance minimum's UNROUNDED
  // theoretical amount would have exceeded this cycle's interest — i.e.
  // rounding, not the policy itself, is what erased the progress. A
  // fixed minimum (or a percent genuinely too small for the rate) is a
  // real debt trap, not a bug — the balance is meant to grow.
  const interestThisCycle = balanceWithInterest - card.currentBalance
  const roundingCouldExplainDeadlock = card.minimumPayment.type === 'percent_of_balance' && (balanceWithInterest * card.minimumPayment.percent) / 100 > interestThisCycle
  if (computedMinimum > 0 && roundingCouldExplainDeadlock && round2(balanceWithInterest - computedMinimum) >= card.currentBalance) return balanceWithInterest
  return computedMinimum
}

/**
 * The card's next minimum charge — the figure to show anywhere the app
 * says "due" or "min. due" for a card.
 *
 * Prefer this over computeMinimumPaymentAmount at every DISPLAY site.
 * computeMinimumPaymentAmount is a pure balance→minimum calculation with
 * no notion of a date, and so cannot consult minimumPaymentOverrides at
 * all. That gave the app two independent answers to one question: the
 * Loans collapsed row and the Home card widget computed their own figure
 * and ignored overrides, while the Summary page and the ledger modal
 * routed through generateMinimumPaymentTransactions and honoured them.
 * Reproduced: a card with the 14 Sep charge overridden to £100 showed
 * £100 on Summary and the modal, £228.07 on Loans and Home, in the same
 * session, from the same data.
 *
 * Routing every display site through the same generator that Summary and
 * the modal already use makes divergence structurally impossible rather
 * than merely currently-absent — an override, a lump payment landing
 * before the charge date, and the interest-then-minimum ordering are all
 * applied in exactly one place. Returns null when the card has no
 * upcoming charge at all (inactive, or nothing owed).
 */
export function nextMinimumChargeAmount(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): number | null {
  // 13 months, so a card whose payment day has already passed this month
  // still finds next month's, and a full year of clamping edge cases
  // (short months, Feb) can't produce an empty window.
  const rangeEnd = new Date(asOfDate.getFullYear() + 1, asOfDate.getMonth() + 1, 0)
  const upcoming = generateMinimumPaymentTransactions(card, asOfDate, rangeEnd, transactions)
  return upcoming.length > 0 ? upcoming[0].amount : null
}

/**
 * What this card ACTUALLY owes as at `asOfDate` — the single source of
 * truth for every "outstanding"/"owed"/"remaining" figure in the app.
 *
 * Replays forward from the stated anchor (card.currentBalance as at
 * card.balanceAsOfDate):
 *  - a billing cycle's interest posts on each paymentDayOfMonth STRICTLY
 *    AFTER the anchor date. Not on the anchor date itself: a stated
 *    balance for a given day already includes that day's statement
 *    interest, so charging it again would inflate the very figure the
 *    person just typed in.
 *  - card activity dated on or after the anchor date and on or before
 *    `asOfDate` is applied in date order — spend adds, payments subtract.
 *    Interest for a date is applied before that date's transactions,
 *    matching how a real statement posts interest and THEN takes the
 *    payment (and matching generateMinimumPaymentTransactions below).
 *
 * Membership is decided BY DATE, not by `status`. Per the confirmed rule,
 * a payment dated today has completed and must be reflected immediately;
 * going by date says so directly instead of depending on whether an
 * auto-clear pass has run yet and flipped a flag. A future-dated payment
 * is excluded because its date hasn't arrived, not because of its status.
 *
 * Anything dated BEFORE the anchor is ignored outright — it's already
 * inside the stated figure, exactly as an opening balance works on the
 * Salary page. This is what makes the anchor safe to re-save: writing the
 * same currentBalance back can no longer erase a payment, because the
 * payment was never inside currentBalance to begin with.
 */
export function cardBalanceAsOf(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): number {
  const asOfIso = toIso(asOfDate)
  const anchorIso = card.balanceAsOfDate

  const activity = transactions
    .filter(
      (t) =>
        t.creditCardId === card.id &&
        (t.type === 'credit_card_spend' || t.type === 'credit_card_payment') &&
        t.date >= anchorIso &&
        t.date <= asOfIso,
    )
    .sort((a, b) => a.date.localeCompare(b.date))

  // Every date on which SOMETHING happens: a billing date (interest) or
  // a transaction. Walking a merged, sorted set of dates keeps the two
  // kinds of event correctly interleaved when they land in the same
  // cycle, without iterating day by day over what could be years.
  const billingDates = billingDatesBetween(card.paymentDayOfMonth, anchorIso, asOfIso)
  const allDates = [...new Set([...billingDates, ...activity.map((t) => t.date)])].sort()

  let balance = card.currentBalance
  // UAT 2026-09-08 (8-bug9.2, Adam-requested grace period) — a real card
  // charges no interest on new spend at all if the account entered the
  // billing cycle already fully paid off; interest only starts (and, in
  // real cards, applies retroactively) once a balance is actually being
  // carried/revolved. `balanceEnteringCycle` is frozen at the value the
  // balance held right after the PREVIOUS billing date's own interest +
  // same-day activity — i.e. what carries INTO this cycle, before this
  // cycle's own new spend gets added — so it survives however much new
  // spend accumulates before this cycle's own billing date is reached.
  let balanceEnteringCycle = card.currentBalance
  for (const date of allDates) {
    if (billingDates.includes(date)) {
      if (balanceEnteringCycle > NEGLIGIBLE_BALANCE) {
        balance = applyMonthlyInterest(balance, card.interestRatePercent)
      } else if (balance <= NEGLIGIBLE_BALANCE) {
        // Grace applies (nothing carried into this cycle) AND there's no
        // new spend to charge interest-free either — still snap a
        // lingering negligible-dust residual to exactly zero, same as
        // applyMonthlyInterest's own guard would have done had it run.
        // Skipping this call entirely (for the grace case) must not also
        // resurrect the pre-Batch-8 stuck-forever-at-a-penny bug.
        balance = 0
      }
    }
    for (const t of activity.filter((a) => a.date === date)) {
      balance = t.type === 'credit_card_spend' ? round2(balance + t.amount) : round2(Math.max(0, balance - t.amount))
    }
    if (billingDates.includes(date)) balanceEnteringCycle = balance
  }
  return round2(Math.max(0, balance))
}

/** Every paymentDayOfMonth occurrence strictly after `afterIso` and on or before `throughIso` — the dates a cycle's interest posts. Clamped to the length of each month, same rule generateMinimumPaymentTransactions uses. */
function billingDatesBetween(paymentDayOfMonth: number, afterIso: string, throughIso: string): string[] {
  const results: string[] = []
  const start = new Date(afterIso)
  const end = new Date(throughIso)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return results
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  let guard = 0
  while (cursor <= end && guard < 1200) {
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const iso = toIso(new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(paymentDayOfMonth, daysInMonth)))
    if (iso > afterIso && iso <= throughIso) results.push(iso)
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    guard++
  }
  return results
}

/**
 * Which statement window's close a given payment date belongs to (item
 * e) — the most recent occurrence of `statementEndDay` before
 * `paymentDate`. Both days recur once a month, and Adam confirmed
 * exactly one close happens between a window's close and its own due
 * date, so this is a plain day-number comparison rather than a real walk:
 * if the close day is numerically EARLIER in the month than the payment
 * day, the relevant close already happened THIS month; otherwise (equal
 * or later) it happened the month before — matches the worked example
 * (close 18th, due 14th: 18 >= 14, so the close is the 18th of the
 * PRECEDING month). Only called once `card.statementEndDay` is set.
 */
function statementCloseDateForPaymentDate(card: CreditCard, paymentDate: Date): Date {
  const endDay = card.statementEndDay!
  const year = paymentDate.getFullYear()
  const month = paymentDate.getMonth()
  if (endDay < card.paymentDayOfMonth) {
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    return new Date(year, month, Math.min(endDay, daysInMonth))
  }
  const daysInPrevMonth = new Date(year, month, 0).getDate()
  return new Date(year, month - 1, Math.min(endDay, daysInPrevMonth))
}

/**
 * The card with its stored anchor swapped for the live derived balance —
 * the one thing READ sites should use. Everything downstream
 * (computeMinimumPaymentAmount, simulateCardPayoffMonths, the What-if
 * engine) already works off `currentBalance`, so handing it a card whose
 * currentBalance IS the live figure keeps all of them correct without
 * each one needing to learn about anchors and replays.
 *
 * Never persist the result: writing it back would re-anchor the card to a
 * figure that already includes activity the replay would then apply a
 * second time.
 */
export function withLiveBalance(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCard {
  return { ...card, currentBalance: cardBalanceAsOf(card, transactions, asOfDate) }
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
 *
 * ITEM E — statement windows: once `card.statementEndDay` is set, each
 * due date's minimum is computed off a SEPARATE `statementBalance` that
 * only picks up real `credit_card_spend` transactions dated on/before
 * that window's own close (statementCloseDateForPaymentDate) — a
 * purchase posted after the close still shows in the card's live balance
 * immediately (via `workingBalance`/`cardBalanceAsOf` elsewhere) but
 * doesn't count toward THIS minimum, rolling into the next window's
 * instead, matching real statement mechanics. Lump payments are NOT
 * window-gated (confirmed against real UK card practice) — they reduce
 * both balances immediately, same as today. Whenever `statementEndDay`
 * is absent, `statementBalance` is kept in lockstep with `workingBalance`
 * the whole way through and never diverges, so the minimum is always
 * read from `workingBalance` as before — byte-identical output to the
 * pre-item-e behaviour for every existing card.
 */
export function generateMinimumPaymentTransactions(
  card: CreditCard,
  rangeStart: Date,
  rangeEnd: Date,
  transactions: Transaction[] = [],
  // UAT 2026-09-08 (Summary page cycle-end totals) — an optional hook,
  // fired once per simulated cycle regardless of whether a charge ends
  // up generated (amount<=0 cycles included), carrying the STATEMENT
  // balance as it stood right before that cycle's own payment/minimum —
  // "the balance due for this period" a real statement would show,
  // which can genuinely differ from the true running balance
  // (cardBalanceAsOf) once a statement window is involved. Exists so
  // callers needing this figure (buildCreditCardCycleSections) share the
  // exact same simulation this function already runs, rather than
  // re-deriving it separately and risking the two ever disagreeing.
  onCycle?: (info: { dateIso: string; statementBalanceBeforePayment: number; workingBalanceBeforePayment: number }) => void,
): Omit<Transaction, 'id'>[] {
  if (!card.active) return []
  const results: Omit<Transaction, 'id'>[] = []

  // The simulation starts from the balance as at RANGE START — not the
  // stored anchor, and not "as of today" either.
  //
  // Not the anchor: it may be months old, with real spend and payments
  // logged since, so a percent-of-balance minimum computed off it would
  // be quoting against a debt that's already partly paid.
  //
  // Not today: rangeStart is routinely in the PAST (projection.ts
  // generates from the current cycle's start so that an occurrence
  // earlier this cycle still appears). Anchoring at today and then
  // simulating a payment dated last week would subtract that payment
  // from a balance which — if it had already been materialized — already
  // reflected it, understating every later month. Anchoring at
  // rangeStart makes the split unambiguous: everything BEFORE rangeStart
  // is inside the starting figure, everything from rangeStart onward is
  // simulated forward exactly once.
  //
  // It also makes this function deterministic given its arguments rather
  // than dependent on the wall clock, which is what let the fixtures
  // below drift as real time passed.
  const rangeStartIso = toIso(rangeStart)
  let workingBalance = cardBalanceAsOf(card, transactions, rangeStart)
  // The statement-window figure (item e) — starts equal to workingBalance
  // and only ever diverges from it when real spend lands after a
  // window's close but before that window's own due date.
  let statementBalance = workingBalance
  // Same cut, applied to logged lump payments: one dated on or before
  // rangeStart is already inside workingBalance above (its transaction
  // was replayed into it), so folding it in again here would
  // double-count. Only ones landing inside the simulated window get
  // applied by the loop below.
  const pendingLumpPayments = card.lumpPayments.filter((lp) => lp.date > rangeStartIso).sort((a, b) => a.date.localeCompare(b.date))
  let lumpIndex = 0
  // item e — real spend dated after rangeStart, needed to know how much
  // of a window's own activity should count toward ITS minimum (spend on
  // or before the close) versus roll into the next one (spend after).
  // Same "already-anchored vs still-to-simulate" cut as lump payments
  // above; spend already inside `workingBalance`/`rangeStart` needs no
  // separate handling here.
  const pendingSpend = transactions
    .filter((t) => t.creditCardId === card.id && t.type === 'credit_card_spend' && t.date > rangeStartIso)
    .sort((a, b) => a.date.localeCompare(b.date))
  // Two INDEPENDENT pointers into the same sorted list — a spend hits
  // workingBalance (the true running balance) as soon as its own date
  // has passed, but may need to wait for a LATER iteration's window to
  // close before it's added to statementBalance (the figure minimums are
  // computed against). A single shared pointer would consume an entry
  // the moment it passed `paymentDateIso` regardless of whether it also
  // cleared `closeDateIso` that same iteration, silently losing it for
  // the later window it actually belongs to.
  let workingSpendIndex = 0
  let statementSpendIndex = 0

  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
  while (cursor <= rangeEnd) {
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
    const paymentDate = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(card.paymentDayOfMonth, daysInMonth))
    const paymentDateIso = toIso(paymentDate)
    const closeDateIso = card.statementEndDay != null ? toIso(statementCloseDateForPaymentDate(card, paymentDate)) : null
    // UAT 2026-09-08 (8-bug9.2, Adam-requested grace period) — frozen
    // BEFORE this cycle's own spend gets folded in below, so it reflects
    // what carried INTO this cycle from the end of the last one. Used
    // just below to decide whether this cycle accrues interest at all —
    // see cardBalanceAsOf's identical mechanism for the full reasoning.
    // Deliberately only tracked for workingBalance — see the interest-
    // gating block below for why statementBalance shares this same gate
    // rather than tracking its own (lagged, window-delayed) version.
    const workingBalanceEnteringCycle = workingBalance

    // Fold in any real spend dated up to this payment date into the true
    // running balance — always, regardless of window.
    while (workingSpendIndex < pendingSpend.length && pendingSpend[workingSpendIndex].date <= paymentDateIso) {
      workingBalance = round2(workingBalance + pendingSpend[workingSpendIndex].amount)
      workingSpendIndex++
    }
    // Fold spend into the statement-window balance only once ITS OWN
    // window has actually closed — `closeDateIso` here is THIS
    // iteration's close, so a spend dated after it waits for a later
    // iteration (whichever one's close finally clears it). No window
    // tracking configured at all (`closeDateIso` null) means every
    // pending spend qualifies immediately, matching workingBalance
    // exactly — the pre-item-e behaviour.
    // No window tracking configured (`closeDateIso` null) falls back to
    // paymentDateIso as the cutoff — identical pacing to workingBalance
    // above, so the two stay byte-identical the whole way through.
    const statementCutoffIso = closeDateIso ?? paymentDateIso
    while (statementSpendIndex < pendingSpend.length && pendingSpend[statementSpendIndex].date <= statementCutoffIso) {
      statementBalance = round2(statementBalance + pendingSpend[statementSpendIndex].amount)
      statementSpendIndex++
    }

    // UAT 2026-09-08 (8-bug9.2-minimum-charges-stop, retest): the
    // NEGLIGIBLE_BALANCE snap only catches a balance that's ALREADY tiny
    // — it never fires for a percent-of-balance minimum stuck on a small
    // but not-tiny balance (e.g. a few tens of pence) where the payment,
    // rounded to the nearest penny, doesn't even cover the interest this
    // cycle accrues on what's left. That's a genuine amortisation
    // deadlock, not a rounding artefact close to zero — captured here so
    // the fix generalises to any such balance, not just ones below a
    // fixed pence threshold.
    const statementBalanceBeforeInterest = statementBalance
    // UAT 2026-09-08, second retest — a statement-window card
    // (statementStartDay/statementEndDay set) can leave workingBalance
    // and statementBalance permanently diverged: a spend lands in
    // workingBalance immediately but statementBalance only picks it up
    // once its own window closes, so the minimum — always sized off
    // statementBalance — can be too small to even cover the interest
    // accruing on the LARGER true workingBalance, which then deadlocks
    // on its own, independently of statementBalance's own (possibly
    // still-progressing) figure. Both must be checked.
    const workingBalanceBeforeInterest = workingBalance

    // Interest for this cycle posts first, against the balance as it
    // stood going into the cycle — THEN any lump payments logged within
    // it reduce the balance, THEN the minimum is calculated against
    // what's left. This slightly overstates interest if a lump payment
    // landed early in the cycle (no daily precision here), which is a
    // deliberate, conservative simplification rather than an attempt at
    // exact accrual. Applied to BOTH balances identically — item e adds
    // no new interest-timing modelling of its own beyond the grace-period
    // check just above: no daily accrual, still no partial-cycle
    // proration, just an all-or-nothing "did this cycle start already
    // clear" gate (Adam-requested, 2026-09-08 — real cards charge no
    // interest on new spend at all if the account entered the cycle fully
    // paid off, only starting once a balance is actually being carried).
    // Grace applies when nothing carried in — but still snap a lingering
    // negligible-dust residual to exactly zero in that case (see
    // cardBalanceAsOf's identical comment): skipping applyMonthlyInterest
    // entirely must not resurrect the pre-Batch-8 stuck-forever-at-a-
    // penny bug for a balance that has no new spend to stay grace-free.
    // Gated on workingBalanceEnteringCycle for BOTH balances, deliberately
    // — whether the account is "carrying debt" is a fact about the real
    // account, and statementBalanceEnteringCycle is a lagged, window-
    // delayed figure that can read as zero even when workingBalance shows
    // real debt was carried in (a spend can sit in workingBalance for a
    // cycle or more before its own window closes and it reaches
    // statementBalance at all). Gating statementBalance on its OWN
    // (falsely-zero) entering value granted grace it hadn't earned —
    // confirmed empirically: a statement-window card that carried real
    // debt into a cycle got its statementBalance's interest wrongly
    // skipped while workingBalance's correctly wasn't, so a same-day lump
    // payment sized to clear the true (interest-inflated) workingBalance
    // then fully zeroed the (interest-free) statementBalance too, and the
    // no-longer-owed difference was silently left stranded in
    // workingBalance forever after.
    if (workingBalanceEnteringCycle > NEGLIGIBLE_BALANCE) {
      workingBalance = applyMonthlyInterest(workingBalance, card.interestRatePercent)
      statementBalance = applyMonthlyInterest(statementBalance, card.interestRatePercent)
    } else {
      if (workingBalance <= NEGLIGIBLE_BALANCE) workingBalance = 0
      if (statementBalance <= NEGLIGIBLE_BALANCE) statementBalance = 0
    }

    // Apply any still-pending lump payments dated on/before this
    // payment date, in date order, BEFORE computing this month's
    // minimum — this is what makes a repayment logged ahead of the next
    // charge date actually count toward it. NOT window-gated (item e,
    // confirmed against real practice) — applies to both balances.
    while (lumpIndex < pendingLumpPayments.length && pendingLumpPayments[lumpIndex].date <= paymentDateIso) {
      workingBalance = round2(Math.max(0, workingBalance - pendingLumpPayments[lumpIndex].amount))
      statementBalance = round2(Math.max(0, statementBalance - pendingLumpPayments[lumpIndex].amount))
      lumpIndex++
    }

    if (paymentDate >= rangeStart && paymentDate <= rangeEnd) {
      // Emitted for past dates within the range too: callers
      // (projection.ts, autoClear.ts) rely on getting them so they can
      // be materialized or deduped against what already exists.
      // A per-date override (credit card ledger modal — "tap a row to
      // adjust") takes precedence over the computed figure, but still
      // feeds into workingBalance below exactly like a computed one
      // would, so later periods' compounding reflects the edit rather
      // than silently reverting to the un-overridden trajectory next
      // month.
      const override = card.minimumPaymentOverrides?.find((o) => o.date === paymentDateIso)
      const computedMinimum = minimumPaymentForBalance(card.minimumPayment, statementBalance)
      // Deadlock guard: if paying this cycle's computed minimum wouldn't
      // leave EITHER balance any lower than it stood BEFORE this cycle's
      // interest was even applied, the payment isn't keeping pace with
      // interest — pay off the larger of the two remaining balances
      // instead of perpetuating a residue that just regrows every month.
      // Checking statementBalance alone isn't enough on a statement-
      // window card (see workingBalanceBeforeInterest's own comment
      // above) — the minimum is sized off statementBalance, but
      // workingBalance is the TRUE debt, and it can be deadlocked even
      // while statementBalance is still (very slowly) progressing. An
      // explicit override is left untouched (a deliberate figure, not
      // the computed one this guard exists to correct).
      // UAT 2026-09-08 (found while adding the grace-period feature,
      // running the full verify-*.ts suite for the first time in a while)
      // — this guard was firing for a genuine, real-world debt trap too:
      // a FIXED minimum (or a percent that's mathematically too small
      // for the rate, regardless of rounding) smaller than the interest
      // accruing is completely real credit-card behaviour — the balance
      // is SUPPOSED to grow, forever, exactly as the pre-existing
      // verify-ledger-phase2.ts debt-trap test expects. That's a
      // different thing entirely from every ORIGINAL bug report here
      // (Adam's 5%-of-balance-vs-20%-APR repros), where the minimum
      // percent mathematically EXCEEDS the monthly rate — it SHOULD
      // converge — and only fails to because of rounding at small-pence
      // scale. Distinguishing the two: only a percent_of_balance minimum
      // whose UNROUNDED theoretical amount would have exceeded this
      // cycle's own interest (i.e. rounding, not the policy itself, is
      // what erased the progress) counts as a deadlock to force-resolve.
      // A fixed minimum, or a percent genuinely smaller than the rate,
      // is left alone — the balance is allowed to grow/stay flat, same
      // as any real card.
      const percent = card.minimumPayment.type === 'percent_of_balance' ? card.minimumPayment.percent : null
      const roundingCouldExplainDeadlock =
        percent != null &&
        ((statementBalance * percent) / 100 > statementBalance - statementBalanceBeforeInterest ||
          (workingBalance * percent) / 100 > workingBalance - workingBalanceBeforeInterest)
      const deadlocked =
        !override &&
        computedMinimum > 0 &&
        roundingCouldExplainDeadlock &&
        (round2(statementBalance - computedMinimum) >= statementBalanceBeforeInterest || round2(workingBalance - computedMinimum) >= workingBalanceBeforeInterest)
      const amount = override ? override.amount : deadlocked ? Math.max(statementBalance, workingBalance) : computedMinimum
      onCycle?.({ dateIso: paymentDateIso, statementBalanceBeforePayment: statementBalance, workingBalanceBeforePayment: workingBalance })
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
        statementBalance = round2(Math.max(0, statementBalance - amount))
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }
  return results
}

/**
 * Logs a purchase charged to this card, right now. Does NOT touch the
 * personal ledger at all (per the confirmed design — see the long comment on TransactionType
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
  // The card is returned UNCHANGED — the transaction below is the whole
  // record of the spend, and cardBalanceAsOf picks it up from there.
  const updatedCard: CreditCard = card
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
/**
 * Total ACTUALLY paid to date against this card — the "paid" half of the
 * card page's pie chart. Scoped BY DATE (on or before today), not by
 * `status`: a payment dated today is treated as done, per the confirmed
 * rule that same-day payments have completed. This is the identical test
 * cardBalanceAsOf uses to decide what counts, which is what keeps the two
 * halves of the pie consistent with each other — when they disagreed
 * (paid rising while outstanding didn't fall) the chart read as
 * half-updated, which is precisely how the bug was reported.
 */
export function totalPaidForCard(cardId: string, transactions: Transaction[], asOfDate: Date = new Date()): number {
  const todayIso = toIso(asOfDate)
  return round2(
    transactions
      .filter((t) => t.type === 'credit_card_payment' && t.creditCardId === cardId && t.date <= todayIso)
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
  // `transactions` MUST be passed through. Omitted, the generator falls
  // back to its default empty list, so its opening balance becomes
  // cardBalanceAsOf(card, [], rangeStart) — which with nothing to replay
  // is just the raw anchor. Reproduced: a Santander card anchored at £0
  // with £228.07 of real spend after the anchor produced NO rows at all
  // (100% of £0 fails the generator's amount > 0 guard), so the modal
  // showed an empty future for a card that genuinely owed £228.07. Any
  // figure that did appear was a manual minimumPaymentOverride being
  // echoed back, never something the modal had computed.
  const generated = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, transactions).filter((t) => !storedDates.has(t.date))

  const rows: CreditCardMinimumChargeRow[] = [
    ...stored.map((t) => ({ date: t.date, amount: t.amount, status: t.status, materialized: true })),
    ...generated.map((t) => ({ date: t.date, amount: t.amount, status: t.date <= todayIso ? ('cleared' as const) : ('pending' as const), materialized: false })),
  ]
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export interface CreditCardBalanceDueRow {
  date: string
  /** The full balance owed as of this date — not just that date's own
   * minimum payment. */
  balanceDue: number
}

/**
 * UAT 2026-09-08 (8-bug9.2-minimum-charges-stop, Adam's own spec, 2nd
 * design pass) — a SEPARATE row from the minimum-charge one above, shown
 * first for the same date in the ledger modal: "I see two rows per
 * payment date, first being any due balance... second row is the minimum
 * charge for the same date." Only for still-UPCOMING payment dates (a
 * past one already happened, nothing left to pre-empt) where the real
 * balance is meaningfully more than that date's own minimum — otherwise
 * there's nothing worth offering an early payoff for. Clearing this row
 * (a lump payment dated on/before this date, for at least this amount)
 * naturally zeroes that date's own minimum AND every later one too, via
 * generateMinimumPaymentTransactions's own existing lump-payment-before-
 * minimum-computation ordering — no separate "future charges" mechanism
 * needed, paying the real balance down to (near) zero is what makes every
 * later minimum compute to zero on its own.
 */
export function buildCreditCardBalanceDueRows(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCardBalanceDueRow[] {
  const minimumRows = buildCreditCardMinimumChargeRows(card, transactions, asOfDate)
  return minimumRows
    .filter((r) => r.status === 'pending')
    .map((r) => ({ date: r.date, balanceDue: cardBalanceAsOf(card, transactions, new Date(r.date)), minimum: r.amount }))
    .filter((r) => r.balanceDue > r.minimum + 0.01)
    .map((r) => ({ date: r.date, balanceDue: r.balanceDue }))
}

export interface CreditCardDueOverviewRow {
  date: string
  balanceDue: number
  /** Whether this date has already happened — a past row is informational only (no Clear action), an upcoming one can be pre-paid via onClearBalance. */
  isPast: boolean
}

/**
 * 2026-09-09 session (Adam-specified) — feeds the Borrowing page's own
 * "most recent + next 3 (or 4 if none recent) payment due dates" section
 * on the expanded credit card, mirroring the Salary page's PayPeriodsSection
 * styling. Deliberately UNFILTERED by "meaningfully more than minimum"
 * (unlike buildCreditCardBalanceDueRows above, which only surfaces dates
 * worth an early payoff nudge) — this is a plain schedule overview, every
 * due date gets its own row with the real balance owed as of that date,
 * same as the info modal now shows for minimum charges alone.
 */
export function buildCreditCardDueOverviewRows(card: CreditCard, transactions: Transaction[], asOfDate: Date = new Date()): CreditCardDueOverviewRow[] {
  const rows = buildCreditCardMinimumChargeRows(card, transactions, asOfDate)
  return rows.map((r) => ({ date: r.date, balanceDue: cardBalanceAsOf(card, transactions, new Date(r.date)), isPast: r.status === 'cleared' }))
}

/** Convenience wrapper over withLiveBalance for a whole list — the shape almost every read site actually wants. Same rule applies: display/compute only, never persisted. */
export function withLiveBalances(cards: CreditCard[], transactions: Transaction[], asOfDate: Date = new Date()): CreditCard[] {
  return cards.map((card) => withLiveBalance(card, transactions, asOfDate))
}

/** This card's own paymentDayOfMonth due date falling in the given calendar month, clamped to the month's real length (short months, Feb) — same clamp generateMinimumPaymentTransactions/billingDatesBetween already use. */
function creditCardDueDateForMonth(card: CreditCard, monthCursor: Date): Date {
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate()
  return new Date(monthCursor.getFullYear(), monthCursor.getMonth(), Math.min(card.paymentDayOfMonth, daysInMonth))
}

/**
 * UAT 2026-09-08 (Summary page cycle-end totals, Adam-requested) — a
 * credit card's own accounting periods: bounded by consecutive PAYMENT
 * dates (paymentDayOfMonth), never the household's own pay-cycle bounds
 * — a card's due date is its own fixed, independent schedule, unrelated
 * to when anyone gets paid.
 *
 * Each period carries `dueDate` (when the payment/minimum actually posts
 * — what "the balance due for this period" means) separately from
 * `windowStart`/`windowEnd` (which real spend counts toward THIS
 * period). When `statementEndDay` is set, `windowEnd` is that period's
 * own statement close — via the exact same `statementCloseDateForPaymentDate`
 * mapping `generateMinimumPaymentTransactions` already uses for minimum-
 * charge sizing — which can land WEEKS before `dueDate` (e.g. a window
 * closing the 18th, due the 14th of the month after next); spend dated
 * in that gap belongs to the FOLLOWING period's window, not this one, so
 * `windowEnd` (not `dueDate`) is the real spend-bucketing bound. A card
 * with no statement window configured falls back to `windowEnd ===
 * dueDate` (spend up to and including the due date itself counts),
 * matching the same "no window" fallback used elsewhere.
 *
 * `count` is the caller's own concern (e.g. 1 for "this cycle", or
 * `1 + THREE_CYCLES_AHEAD` for "next 3 cycles", matching
 * projection.ts's horizonCycles convention of current-cycle-first) —
 * kept as a plain number rather than importing ProjectionHorizon/
 * THREE_CYCLES_AHEAD from projection.ts, which itself imports FROM this
 * file (generateMinimumPaymentTransactions) and would create a cycle.
 */
export function creditCardCyclePeriods(card: CreditCard, asOfDate: Date, count: number): { windowStart: Date; windowEnd: Date; dueDate: Date }[] {
  const asOfIso = toIso(asOfDate)

  // The "current" period is the one whose OWN due date hasn't happened
  // yet (today counts as not-yet-happened, same "due today is still
  // this period" convention the rest of the app uses).
  let cursor = new Date(asOfDate.getFullYear(), asOfDate.getMonth(), 1)
  let dueDate = creditCardDueDateForMonth(card, cursor)
  while (toIso(dueDate) < asOfIso) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    dueDate = creditCardDueDateForMonth(card, cursor)
  }

  const dueDates: Date[] = [dueDate]
  for (let i = 1; i < count; i++) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    dueDates.push(creditCardDueDateForMonth(card, cursor))
  }

  return dueDates.map((due) => {
    const prevMonthCursor = new Date(due.getFullYear(), due.getMonth() - 1, 1)
    const prevDue = creditCardDueDateForMonth(card, prevMonthCursor)
    const windowEnd = card.statementEndDay != null ? statementCloseDateForPaymentDate(card, due) : due
    const windowStart = card.statementEndDay != null ? addDays(statementCloseDateForPaymentDate(card, prevDue), 1) : addDays(prevDue, 1)
    return { windowStart, windowEnd, dueDate: due }
  })
}

export interface CreditCardCycleSection {
  windowStart: Date
  windowEnd: Date
  dueDate: Date
  /** Real spend/payments whose date falls in (windowStart, windowEnd], plus
   * this period's own minimum-charge/interest row (dated exactly on
   * dueDate) if one applies — real transactions where they already
   * exist, generated/projected ones otherwise, exactly like
   * buildCreditCardMinimumChargeRows' own materialized-wins rule. */
  rows: { date: string; type: 'credit_card_spend' | 'credit_card_payment'; amount: number; status: 'cleared' | 'pending'; note?: string; sourceType?: string }[]
  /** The real balance owed as of dueDate — "the balance due for this
   * period" — via cardBalanceAsOf, not a manual fold of `rows` (interest
   * itself has no row of its own to fold, so summing rows would silently
   * omit it). */
  closingBalance: number
}

/**
 * UAT 2026-09-08 (Summary page cycle-end totals, Adam-requested) — one
 * section per credit-card cycle period, each with its own spend/payment
 * rows and its own closing (due) balance — the credit-card equivalent of
 * projection.ts's horizonCycles + Home.tsx's CycleGroupedList, but using
 * this card's own periods (see creditCardCyclePeriods) instead of the
 * household pay cycle, and a real cardBalanceAsOf query for each
 * period's closing figure instead of a running-balance fold (which
 * would miss interest, since interest has no transaction row of its
 * own). "We also need to make sure minimum charges appear in this same
 * ledger" — a period's own not-yet-materialized minimum charge is
 * generated here exactly like the info modal's ledger does, so an
 * upcoming due date's charge is visible before autoClear ever
 * materializes it into a real Transaction.
 */
export function buildCreditCardCycleSections(card: CreditCard, transactions: Transaction[], cycles: { windowStart: Date; windowEnd: Date; dueDate: Date }[]): CreditCardCycleSection[] {
  if (cycles.length === 0) return []
  const rangeStart = cycles[0].windowStart
  const rangeEnd = cycles[cycles.length - 1].dueDate

  const cardTransactions = transactions.filter((t) => t.creditCardId === card.id && (t.type === 'credit_card_spend' || t.type === 'credit_card_payment'))
  // Same materialized-wins dedupe rule as buildCreditCardMinimumChargeRows:
  // a stored (real, not-lump-payment) credit_card_payment on a given date
  // IS that date's minimum charge already actually happening — the
  // generator's own projection for that same date would just restate it.
  const storedMinimumDates = new Set(cardTransactions.filter((t) => t.type === 'credit_card_payment' && !t.sourceType).map((t) => t.date))
  // UAT 2026-09-08 — the `onCycle` hook captures the real STATEMENT
  // balance the simulation computed for each due date, regardless of
  // whether a charge ended up generated for it (a cycle with nothing due
  // pushes no row at all) — "the balance due for this period" a real
  // statement would show, which is what closingBalance below uses,
  // rather than cardBalanceAsOf's true-running-balance figure (which
  // would incorrectly include spend that hasn't reached this period's
  // own statement yet — see the type's own comment on windowEnd vs
  // dueDate for why that gap is real).
  const statementBalanceByDate = new Map<string, number>()
  const generatedMinimums = generateMinimumPaymentTransactions(card, rangeStart, rangeEnd, transactions, ({ dateIso, statementBalanceBeforePayment }) =>
    statementBalanceByDate.set(dateIso, statementBalanceBeforePayment),
  ).filter((t) => !storedMinimumDates.has(t.date))
  const todayIso = toIso(new Date())
  const allRows = [
    ...cardTransactions.map((t) => ({ date: t.date, type: t.type as 'credit_card_spend' | 'credit_card_payment', amount: t.amount, status: t.status, note: t.note, sourceType: t.sourceType })),
    ...generatedMinimums.map((t) => ({ date: t.date, type: t.type as 'credit_card_spend' | 'credit_card_payment', amount: t.amount, status: (t.date <= todayIso ? 'cleared' : 'pending') as 'cleared' | 'pending', note: t.note, sourceType: t.sourceType })),
  ]
  // For cardBalanceAsOf, which needs real Transaction-shaped objects with
  // an id — the generated rows above have none, since they're pure
  // projections.
  const allAsTransactions: Transaction[] = [
    ...cardTransactions,
    ...generatedMinimums.map((t, i) => ({ ...t, id: `projected-${i}` })),
  ]

  return cycles.map((cycle) => {
    const windowStartIso = toIso(cycle.windowStart)
    const windowEndIso = toIso(cycle.windowEnd)
    const dueDateIso = toIso(cycle.dueDate)
    const rows = allRows
      .filter((r) => {
        // A minimum-charge row is EXPLICITLY dated on a due date by
        // construction — it must anchor to THAT due date's own section
        // exclusively. Without this, a due date numerically sitting
        // inside the FOLLOWING cycle's own spend window (a real
        // possibility — see the type's own comment on why windowEnd,
        // not dueDate, bounds spend) would wrongly pull it into that
        // later section too, double-counting the same charge.
        const isMinimumChargeRow = r.type === 'credit_card_payment' && !r.sourceType
        if (isMinimumChargeRow) return r.date === dueDateIso
        return r.date >= windowStartIso && r.date <= windowEndIso
      })
      .sort((a, b) => a.date.localeCompare(b.date))
    // Fallback only for a due date genuinely outside the simulated range
    // (shouldn't happen — rangeEnd is always the last cycle's own
    // dueDate — but cardBalanceAsOf is a safe, real answer either way).
    const closingBalance = statementBalanceByDate.get(dueDateIso) ?? cardBalanceAsOf(card, allAsTransactions, cycle.dueDate)
    return { ...cycle, rows, closingBalance }
  })
}
