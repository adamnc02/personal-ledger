// ─────────────────────────────────────────────────────────────────────────
// NEW DATA MODEL — proposed shape for the rebuild.
//
// This supersedes src/types/models.ts for the parts of the app that are
// being rebuilt (see requirements doc, Section 4). It is written to sit
// alongside the current app's types during development, not as a live
// replacement — nothing here is wired up yet. The intent is to agree on
// the shape first, then build the Phase 1 ledger/summary UI against it.
//
// What's kept from the old model (imported, not redefined here):
//  - PayFrequency, StudentLoanPlan, SalaryDeduction, DeductionType,
//    DeductionAmountType — the tax engine's inputs are unchanged.
//  - BillLocation ('personal' | 'joint') and the payee/payeeSharePercent
//    split model — this is the one piece of shared plumbing everything
//    else depends on, and it ports over unchanged (doc Section 4.2).
//  - Scenario / ScenarioActionType (What-if) — unchanged, see the note
//    on WhatIfScenario below.
//
// What's new: Transaction, Category, RecurringTemplate (replaces Bill),
// the updated Loan shape, PayCycleConfig, SalarySnapshot/SalaryOverride,
// and the AppDataV2 root object that ties them together.
// ─────────────────────────────────────────────────────────────────────────

import type { PayFrequency, SalaryDeduction, StudentLoanPlan } from '../lib/tax'
import type { BillLocation, Scenario } from './models'

// ── Shared enums ────────────────────────────────────────────────────────

// Confirmed answer to the doc's Section 5 open question: these five, no
// others, for the initial build.
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'direct_debit' | 'standing_order'

export type TransactionStatus = 'cleared' | 'pending'

// What generated this transaction / what it represents. `bill_payment` and
// `loan_payment` are generated from a RecurringTemplate or Loan on schedule;
// the rest are logged directly on the Expenses/Ad-hoc page (doc Section 4.3).
export type TransactionType =
  | 'bill_payment'
  | 'loan_payment'
  | 'expense' // ad-hoc, one-off outgoing paid by cash/bank transfer/direct debit/standing order — real cash out
  | 'income' // ad-hoc, one-off incoming, no effect on standing salary — e.g. a cash gift, a bank transfer from family
  | 'bonus' // ad-hoc incoming that DOES add to that period's net pay — see SalaryOverride
  | 'salary' // the regular pay-day transaction, generated from Person.salary
  // Something charged TO a credit card, logged from the Transactions page with
  // paymentMethod: 'card'. Deliberately NOT real cash out: this does not
  // touch the ledger's running balance and does not appear on the
  // Personal card's transaction list — it only shows on the specific
  // credit card's own list, and increases that card's currentBalance.
  // direction: 'out' (uses available credit, same convention as any other
  // outgoing type). On the credit card's OWN transaction list, this is
  // displayed as a POSITIVE charge (it added to the balance owed) — that
  // display sign is derived from `type`, not from `direction`; see
  // CreditCard below. creditCardId is required on this type.
  | 'credit_card_spend'
  // A payment made FROM the ledger TOWARD a credit card — the generated
  // monthly minimum/fixed payment, or a logged ad-hoc lump payment. This
  // IS real cash out: it reduces the ledger balance and DOES appear as a
  // negative amount on the Personal card, same as any other outgoing
  // transaction — this is the "modern banking app" behaviour: paying
  // down a card is an expense against your cash account. direction:
  // 'out' (same reasoning — cash left the personal ledger). On the
  // credit card's OWN transaction list, this is displayed as a NEGATIVE
  // charge (it reduced the balance owed) — again derived from `type`,
  // not `direction`. Reduces that card's currentBalance. creditCardId is
  // required on this type.
  | 'credit_card_payment'
  // A recurring contribution toward a savings goal or monthly plan,
  // generated on the same payday dates as salary (doc addendum — "the
  // saving recurring date is the same as the salary payment date, so it
  // automatically gets saved when salary arrives"). Always forced onto
  // SAVINGS_CATEGORY_ID — there's no category picker for these, same
  // idea as credit_card_payment. sourceType 'savings_entry' + sourceId
  // link it back to the SavingsEntry it came from, which is how clearing
  // one quietly increases that goal's currentAmount — see the "mark
  // cleared" side-effect handling in LedgerContext.
  | 'savings_contribution'

export type RecurrenceFrequency = 'weekly' | 'every_n_weeks' | 'monthly' | 'quarterly' | 'annual'

// ── Category ────────────────────────────────────────────────────────────
// First-class entity (doc Section 3.5 / 4.1). Icon + colour live here now,
// not on the individual Bill/Loan/Transaction — every item in a category
// inherits its look automatically. Auto-generated on creation (name in,
// icon+colour chosen automatically); the picker/"key" UI goes away.

// Reserved built-in category id, seeded at app init (isBuiltIn: true,
// undeletable). Every credit_card_payment/credit_card_spend transaction
// carries the owning CreditCard's own (freely user-assignable)
// categoryId, NOT this one directly — this id exists so there's always a
// sensible default to assign a new card to, and so the "group by
// category" summary view (Home.tsx's groupingCategoryId) has a fixed,
// stable bucket to fold every credit-card-related transaction into
// regardless of what real category any individual card carries.
export const CREDIT_CARD_CATEGORY_ID = 'category-credit-card'

// Reserved built-in category id for generated 'salary' transactions
// (Phase 3 — see lib/salaryLedger.ts). Ad-hoc 'income'/'bonus' entries
// are NOT forced onto this one — the person can pick it from the list
// like any other category, or pick something else, since those are
// logged by hand and a forced category would be presumptuous. Only the
// auto-generated payday transaction always uses it.
export const INCOME_CATEGORY_ID = 'category-income'

// Reserved built-in category id for a generic default bills category —
// one of the three defaults (alongside Credit Card and Income) that are
// always present and visible in the category management modal, so
// there's always something sensible to pick even before the person has
// created any categories of their own.
export const BILLS_CATEGORY_ID = 'category-bills'

// Reserved built-in category id for every savings_contribution
// transaction — no category picker for these, same as Credit Card.
export const SAVINGS_CATEGORY_ID = 'category-savings'

export interface Category {
  id: string
  name: string
  icon: string // key into the built-in icon library, see lib/billIcons.ts
  iconColor: string // hex color
  // True for the handful of categories the app ships with (e.g. general
  // "Bills", "Loans" fallbacks) — these can't be deleted, only renamed.
  isBuiltIn?: boolean
}

// ── Transaction — the central new entity ───────────────────────────────
// A single dated, amount-bearing entry. Recurring templates, loans, and
// salary are *generators* of these, not the source of truth themselves
// (doc Section 4.1). The running balance is a fold over this list.

export interface Transaction {
  id: string
  date: string // ISO date — when it clears/is due, not necessarily when it was entered
  amount: number // always positive; direction below decides the sign
  // Sign convention on the Personal/Joint/Household ledger, summarised —
  // 'out' always displays negative, 'in' always displays positive, no
  // exceptions (this is the one place `direction` unambiguously controls
  // display sign; see TransactionType above for the credit-card types,
  // where the card's OWN list uses a separate, `type`-derived sign):
  //   'out' (negative): bill_payment, loan_payment, expense, credit_card_payment
  //   'in'  (positive): salary, bonus, income
  direction: 'in' | 'out'
  // Always CREDIT_CARD_CATEGORY_ID for type 'credit_card_spend' or
  // 'credit_card_payment' — enforced at creation, not just render.
  categoryId: string
  paymentMethod: PaymentMethod
  status: TransactionStatus
  type: TransactionType
  note?: string
  // Whose account this sits in for personal/joint/household splitting —
  // same split model as Bill/Loan today. Not used for direction: 'in'
  // salary/bonus/income entries tied to a specific person (use personId
  // instead); used for bill/loan payments and ad-hoc expenses.
  location: BillLocation
  ownerId: string // whose personal account, when location = 'personal'
  payee?: string
  payeeSharePercent?: number
  // Which person this belongs to — required for salary/bonus/income,
  // optional context otherwise.
  personId?: string
  // Back-link to what generated this, so edits/deletes on the template
  // can find their generated instances. Undefined for genuinely ad-hoc
  // entries (expense/income logged directly, not from a template).
  // 'credit_card_lump_payment' links a credit_card_payment transaction
  // back to the specific CreditCardLumpPayment record (sourceId), when
  // it wasn't the generated monthly/minimum payment.
  sourceType?: 'recurring_template' | 'loan' | 'loan_overpayment' | 'loan_recurring_overpayment' | 'loan_settlement' | 'credit_card_lump_payment' | 'savings_entry'
  sourceId?: string
  // Required when type is 'credit_card_spend' or 'credit_card_payment' —
  // which card this is against. See TransactionType above for how each
  // type does or doesn't affect the ledger balance / Personal card list.
  creditCardId?: string
}

// ── RecurringTemplate — replaces today's Bill ──────────────────────────
// Generalises Bill with a real frequency instead of an implicit "monthly,
// due on day N" (doc Section 3.1, classified Rebuild). Generates
// Transactions on schedule; itself holds no cleared/pending state.

export interface RecurringTemplate {
  id: string
  name: string
  amount: number // the CURRENT amount — always what's shown/edited in the form. See amountEffectiveFrom/amountHistory below for how a scheduled change is recorded without disturbing this.
  categoryId: string
  paymentMethod: PaymentMethod
  frequency: RecurrenceFrequency
  // Only meaningful when frequency === 'every_n_weeks'.
  intervalWeeks?: number
  // Anchor date the schedule is generated from — e.g. for 'monthly' this
  // is only used for its day-of-month; for 'weekly'/'every_n_weeks' the
  // weekday and cadence both come from this date; for 'quarterly'/'annual'
  // it's the first occurrence.
  anchorDate: string // ISO date
  location: BillLocation
  ownerId: string
  payee: string
  payeeSharePercent: number
  active: boolean // paused templates stop generating new transactions
  // ISO date `amount` has applied from. Absent means `amount` has always
  // applied (no recorded change) — the common case for a bill that's
  // never had its value edited with a specific "starting from" payment.
  // Set together with amountHistory whenever a change is confirmed
  // through the "which payment should this apply from" picker (Bills.tsx)
  // — see resolveTemplateAmount in schedule.ts for how these three fields
  // combine to answer "what did/will this bill cost on date X."
  amountEffectiveFrom?: string
  // Superseded amounts, each with the date IT started applying from —
  // mirrors Person.salaryHistory's snapshot pattern (see
  // salaryLedger.ts's findApplicableSnapshot) rather than inventing a new
  // shape: every past value is its own self-contained entry, and
  // resolving "what applied on date X" is the same kind of
  // latest-entry-not-after-X lookup either way.
  amountHistory?: { effectiveFrom: string; amount: number }[]
}

// ── Loan — updated inputs, native overpayments ─────────────────────────
// Primary inputs flip to monthly amount + term, with total payable
// becoming a derived/display figure — closer to how a real loan agreement
// reads, and it stops the "no consideration for interest" schedule drift
// the doc's Section 3.2 calls out. Real overpayments are now recorded
// here and actually reduce the tracked balance; the What-if page's
// hypothetical "loan_overpayment" scenario action is unrelated to this —
// it never reads or writes here, see WhatIfScenario below.

export interface Loan {
  id: string
  name: string
  monthlyPayment: number
  termMonths: number
  startDate: string // ISO date of first payment
  // Derived at render time from monthlyPayment × termMonths, adjusted for
  // recorded overpayments — not stored, but documented here since it's a
  // load-bearing display value (doc Section 3.2). Computed by lib code,
  // not part of the persisted shape.
  categoryId: string
  location: BillLocation
  ownerId: string
  payee: string
  payeeSharePercent: number
  overpayments: LoanOverpayment[]
  // Optional standing/recurring overpayment on top of the normal monthly
  // payment — e.g. "an extra £100 every month" or "an extra 5% of
  // whatever's left, every month, until it's paid down." Distinct from
  // `overpayments` above, which are one-off, individually-logged extra
  // payments. Folded into the SAME monthly loan_payment transaction
  // amount when generated (not its own separate ledger line) — see
  // ledgerLoans.ts's buildLoanSchedule for how it compounds down for the
  // percent-of-balance case, same idea as a credit card's minimum
  // payment recalculating against the live balance every cycle.
  recurringOverpayment?: LoanRecurringOverpayment

  // ── Amortisation-engine fields (loan-amortisation-engine scope) ──────
  // `principal` is required, added during the amortisation-engine build:
  // `monthlyPayment × termMonths` was usable as a stand-in "balance" for
  // the old flat model (which had no concept of interest, so "total
  // you'll ever pay" and "what you actually borrowed" were the same
  // number by definition) but that stops being true the moment real
  // interest exists — a real loan's total repayable is always MORE than
  // its principal. The engine needs the true starting balance as its own
  // input, not a derived one. See migrateLedgerData in ledgerStorage.ts
  // for how a loan persisted before this field existed gets a one-time
  // best-effort backfill.
  principal: number
  // Everything below is optional/derived at the type level so a loan
  // still works with zero extra input beyond principal (scope §5.2's
  // back-solved baseline) — calibration only refines what's already a
  // strong estimate, it isn't required to make a loan usable.
  lender?: string // free text (scope §4) — labels a saved calibration profile so a future loan from the same lender can offer to reuse it. Not used for hard-coded formulas.
  apr?: number // percentage, e.g. 16.93 — matches CreditCard.interestRatePercent's convention. Purely a reference/pre-fill value: at creation, it suggests a starting monthlyPayment via the standard PMT formula, but the person's REAL contractual payment (freely overridable) is what everything downstream actually uses — back-solving the effective rate from Payment+Principal+Term (resolveLoanRateAndConvention) has consistently proven more accurate than trusting the displayed APR directly, since a displayed APR is routinely rounded and a lender's real internal rate can sit a hair either side of it (see the loan-amortisation-engine scope's Santander/Monzo reconciliation). Never read by the core engine for anything else — this is deliberate, not an oversight.
  advanceDate?: string // ISO — distinct from startDate/firstPaymentDate (scope §4): routinely 3-8 weeks earlier, and one known convention (Monzo) charges interest from this date, not the first payment date. Falls back to startDate when absent (baseline behaviour: no stub period).
  interestConventionId?: string // matches InterestConvention.id in lib/interestConventions.ts — which candidate fitted best, once calibrated. Falls back to the flat-monthly baseline convention when absent — see resolveLoanRateAndConvention in ledgerLoans.ts.
  calibratedMonthlyRate?: number // the fitted (or back-solved-from-payment, pre-calibration) monthly rate. Always a MONTHLY figure regardless of which convention uses it — see interestConventions.ts's file header for why.
  settlementMultiplier?: number // 'k' in settlement ≈ balance × (1 + k × monthlyRate) (scope §6). Defaults applied (k=2 if >12 months remain, else k=1) when absent — only stored once calibrated/overridden against a real settlement quote.
  statementCalibrationLines?: StatementCalibrationLine[] // raw entered calibration inputs, persisted so re-fitting always uses the whole accumulated set (scope §5.3), not just the newest line.
  active: boolean // mirrors CreditCard.active (scope §7) — false once "Settle this loan" has been used to log a real payoff.
  closedDate?: string // ISO date — set together with active: false, when the loan was actually settled. summarizeLoan uses this directly as payoffDate for a closed loan, rather than trusting whatever the mechanical schedule would otherwise predict.
  settledAmount?: number // the REAL amount actually paid to close the loan (scope §7) — may genuinely differ from the app's own settlement estimate (§6). The source of truth for the ledger itself is still the logged Transaction (sourceType: 'loan_settlement'); this is kept on the loan too purely so the Borrowing page can show "Settled for £X" without a separate lookup.
}

export interface StatementCalibrationLine {
  date: string // ISO date
  capital: number
  interest: number
}

export interface LoanRecurringOverpayment {
  startDate: string // ISO date — first month this applies from
  endDate?: string // ISO date, inclusive — last month it applies; unset = indefinite, until the loan itself is paid off
  amount: { type: 'fixed'; amount: number } | { type: 'percent_of_balance'; percent: number }
  // Recast choice (loan-amortisation-engine scope §9, §11.3) — how the
  // schedule responds once this overpayment lands. 'reduce_term'
  // (default when absent, matching every recurring overpayment recorded
  // before this field existed): keep the payment the same, the loan
  // finishes sooner. 'reduce_payment': keep the same remaining period
  // count, recompute a smaller payment via standard PMT against the new
  // balance — for a RECURRING overpayment this means the effective
  // payment can genuinely change at every period it's applied, not just
  // once, since buildLoanSchedule.ts's own comment on this explains why
  // the schedule tracks a per-period payment rather than one fixed
  // figure once this combination is in play.
  recastMode?: 'reduce_term' | 'reduce_payment'
}

export interface LoanOverpayment {
  id: string
  date: string // ISO date
  amount: number
  note?: string
  // Same recast choice as LoanRecurringOverpayment.recastMode above, but
  // for a one-off overpayment — applies once, at this overpayment's own
  // date, recomputing the loan's effective payment from that point
  // onward (until a later recast changes it again, or the loan pays
  // off). Defaults to 'reduce_term' when absent (every overpayment
  // recorded before this field existed keeps its original behaviour
  // exactly — the fixed payment continuing, term shortening).
  recastMode?: 'reduce_term' | 'reduce_payment'
}

// ── Pay cycle configuration ─────────────────────────────────────────────
// Anchors the running balance. Payday and the budgeting-cycle boundary
// are stored as two separate, deliberately-decoupled rules (doc Section
// 3.3): the cycle boundary (e.g. 14th–13th) stays fixed even when the
// actual payday drifts a day or two earlier for a weekend/bank holiday.

export interface PayCycleConfig {
  // Per-person or household — TBD once we settle the multi-person split
  // for this; modelled per-person for now since salary is per-person.
  personId: string
  openingBalance: number
  openingBalanceDate: string // ISO date the opening balance was true as of
  // The nominal day of the month payday falls on.
  paydayDayOfMonth: number
  // If paydayDayOfMonth falls on a weekend or UK bank holiday, pay the
  // last working day on or before it. UK bank-holiday awareness needed —
  // flagging as a lib dependency (a bank-holiday calendar/lookup), not a
  // config field.
  paydayAdjustForNonWorkingDay: boolean
  // The budgeting cycle boundary — day of month the "month" starts on
  // for summary/projection purposes. Independent of paydayDayOfMonth.
  cycleStartDayOfMonth: number
  // OVERRIDE: when true, the cycle boundary stops being a fixed day of
  // the month and instead follows the RESOLVED payday — i.e. the same
  // weekend/bank-holiday adjustment paydayAdjustForNonWorkingDay applies
  // to payday is applied to the cycle boundary too, so a cycle always
  // begins on the day the money actually lands.
  //
  // This exists because setting cycleStartDayOfMonth to the same number
  // as paydayDayOfMonth does NOT achieve that: the two fields are
  // deliberately independent (see lib/payCycle.ts's header), so the
  // boundary stayed pinned to the nominal date while the real payday
  // drifted earlier — putting a payday in the wrong cycle every time the
  // nominal date fell on a weekend or bank holiday.
  //
  // Optional and defaults to FALSE, so every already-persisted config
  // keeps the fixed-day behaviour with no migration. When true,
  // cycleStartDayOfMonth is retained but unused (so unticking restores
  // the previous setting rather than losing it).
  cycleStartFollowsPayday?: boolean
}

// ── Credit cards ─────────────────────────────────────────────────────────
// Created/managed on the Borrowing page, alongside Loan. Personal only — no
// joint/split model (confirmed). The card's minimum/monthly payment is
// treated as a bill: it's a generator, same idea as RecurringTemplate/
// Loan, producing a `credit_card_payment` Transaction on paymentDayOfMonth
// each cycle. currentBalance is adjusted by two independent flows, which
// are kept deliberately separate from each other in the ledger:
//  - UP, when a `credit_card_spend` transaction is logged against this
//    card from the Transactions page. This does NOT touch the ledger's
//    running balance and does NOT show on the Personal card's list —
//    only on this card's own list, as a POSITIVE charge.
//  - DOWN, when a `credit_card_payment` transaction is generated (the
//    minimum/monthly payment) or a CreditCardLumpPayment is logged. This
//    IS real cash out — it reduces the ledger balance and shows as a
//    negative amount on the Personal card (matches how a real banking
//    app treats a card payment: an expense against your cash account).
//    On the card's OWN list it shows as a NEGATIVE charge.
//
// The card page's pie chart (total paid vs total outstanding) uses:
//  - outstanding = currentBalance (this already reflects spend, since
//    spend increases it directly — so card spend does feed into the
//    chart, just as "more borrowed", without ever touching the cash
//    ledger or any other expense/category report in the app).
//  - paid = the running sum of all credit_card_payment amounts logged
//    against this card to date.
//
// minimumPayment.percentOfBalance is NOT cached as a fixed £ amount — it
// must be recalculated at generation time against currentBalance for that
// cycle, since a fixed percentage of a shrinking balance shrinks in turn
// (5% of next month's lower balance < 5% of this month's). This is lib
// logic, not part of the persisted shape.

export interface CreditCard {
  id: string
  name: string
  categoryId: string // for icon; colour below overrides the category's colour
  color: string // hex — drawn from CREDIT_CARD_COLORS, not the personal/joint/household palette
  interestRatePercent: number // APR — genuinely used now: compounds monthly against the balance each billing cycle. See lib/creditCards.ts's monthlyInterestRate for the conversion, and its file header for what's deliberately NOT modelled (daily accrual, purchase grace periods).
  // The STATED balance as at balanceAsOfDate — an anchor, not a live
  // figure. It is never adjusted by the app: spend and payments are not
  // written back into it, and what the card actually owes right now is
  // DERIVED by replaying card activity forward from the anchor date
  // (cardBalanceAsOf in lib/creditCards.ts).
  //
  // This pairing deliberately mirrors PayCycleConfig's openingBalance /
  // openingBalanceDate, and exists for the same reason. currentBalance
  // used to be mutated in place every time a payment cleared, which made
  // it impossible to tell which transactions were already baked into it
  // — so every write path had to hand-reverse its own balance effect,
  // and any code holding a stale copy of the card could silently undo a
  // payment by saving it back. That is exactly what happened: logging a
  // payment from the Borrowing page reduced the balance, then pressing
  // Save on the (still-open, still-stale) edit panel restored the old
  // figure, while the payment transaction remained — so the pie chart
  // showed the amount paid going up but the outstanding amount never
  // coming down. Deriving removes the whole class of bug rather than
  // patching that one path.
  currentBalance: number
  balanceAsOfDate: string // ISO date the currentBalance figure above was true as at. Card activity dated BEFORE this is ignored (already reflected in the figure); activity on or after it is applied on top.

  minimumPayment: CreditCardMinimumPayment
  paymentDayOfMonth: number // like Bill.dueDay — when the minimum/fixed payment is generated
  ownerId: string // personal only, no location/payee split
  lumpPayments: CreditCardLumpPayment[]
  active: boolean
  // Per-date overrides for the generated minimum charge — set via the
  // credit card ledger modal's "tap a row to adjust" (mirrors the loan
  // ledger modal, but this one's rows are editable). Only used for a date
  // that hasn't been materialized into a real stored Transaction yet; a
  // date that already has one gets edited directly on that transaction
  // instead (see LedgerContext's updateCreditCardMinimumCharge) — an
  // override existing here for an already-materialized date would be
  // silently ignored by generateMinimumPaymentTransactions, since a
  // materialized date is never re-generated in the first place.
  minimumPaymentOverrides?: { date: string; amount: number }[]
}

export type CreditCardMinimumPayment =
  | { type: 'fixed'; amount: number }
  | { type: 'percent_of_balance'; percent: number } // e.g. 5 = 5% of currentBalance, recalculated each cycle

export interface CreditCardLumpPayment {
  id: string
  date: string // ISO date
  amount: number
  note?: string
}

// A palette distinct from the coral/ice/dark-blue used for the Personal/
// Joint/Household summary cards (index.css: --color-coral, --color-joint,
// implicit dark-blue household surface) — cards need their own space so
// they're never confused with the three account-summary cards. Assigned
// round-robin on creation, same pattern as Category auto-colour.
export const CREDIT_CARD_COLORS = [
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#f59e0b', // amber
  '#ec4899', // pink
  '#84cc16', // lime
  '#06b6d4', // cyan
] as const

// ── Salary snapshots + overrides ────────────────────────────────────────
// Person.salary becomes a dated history rather than one fixed figure
// (doc Section 3.4). A "salary change" is either:
//  - permanent: a new SalarySnapshot, effective from a date, affecting
//    current + upcoming periods only (never retroactive).
//  - one-off: a SalaryOverride against a single pay period, e.g. a bonus
//    month — doesn't touch the standing snapshot at all. Per Mum's
//    confirmation this is the common case in practice, so it needs to be
//    the quick path, not a buried edge case.
// Phase 1 scope note (doc Section 3.4): only a manual net-pay override is
// supported for a given period — no automatic tax-code-change modelling
// yet, that's an explicitly separate future conversation.

export interface SalarySnapshot {
  id: string
  personId: string
  effectiveFrom: string // ISO date — this snapshot applies from here until superseded
  grossAnnual: number
  taxCode: string
  studentLoanPlan: StudentLoanPlan
  payFrequency: PayFrequency
  deductions: SalaryDeduction[]
  employerPensionPercent?: number
}

export interface SalaryOverride {
  id: string
  personId: string
  payPeriodDate: string // ISO date of the specific pay period this applies to
  // Manual net-pay figure for that one period — bypasses the tax engine
  // entirely for this period, per doc Section 3.4's "user can manually
  // override net pay" caveat.
  netPayOverride: number
  reason?: string // e.g. "April bonus"
  // Set only when this override was produced by "Attach a bonus to a pay"
  // (the GROSS bonus figure the person typed in) rather than a plain manual
  // net-pay override. netPayOverride in that case = the snapshot's ordinary
  // computed net pay for this period + the bonus's taxed net value — kept
  // around purely so the bonus can be edited/removed later without the
  // person having to re-derive what the "extra" amount even was. A plain
  // manual override (typed directly into "override net pay") never sets
  // this field.
  bonusGrossAmount?: number
}

export interface Person {
  id: string
  name: string
  color: string
  salaryHistory: SalarySnapshot[] // sorted by effectiveFrom; current = latest snapshot on/before "today"
  salaryOverrides: SalaryOverride[]
  savingsEntries: SavingsEntry[] // unchanged shape from the current app
}

export interface SavingsEntry {
  id: string
  type: 'goal' | 'plan'
  name: string
  includeInSummary: boolean
  targetAmount?: number
  currentAmount?: number
  targetDate?: string
  monthlyAmount?: number
  // Unset = contributions generate on every payday, indefinitely. Set =
  // generate normally for paydays before this date, then stop from this
  // date on — covers both "cancel" (set to today/the next payday) and
  // "suspend from a future month" (set to that date) with one field,
  // rather than a separate active/paused flag that could drift out of
  // sync with a date. Clear it (or push it further out) to resume.
  pausedFrom?: string
}

// ── What-if scenarios — decoupled from the ledger, NOW NEEDS A CHANGE ──
// The What-if page stays a pure hypothetical planning layer: it reads
// default/current data to run its calculations but never writes to
// Transaction, RecurringTemplate, Loan, or CreditCard. That part is
// unchanged. What DOES need to change: 'pay_off_loan', 'loan_overpayment',
// 'exclude_loan', and the sell_asset/pay_off_loan `loanAllocations` array
// are all currently loan-only (linkedLoanId, loanId). You asked to be
// able to target a credit card with these same actions, which means
// generalising the target from "loan" to "debt" — e.g. renaming
// linkedLoanId → linkedDebtId with a companion linkedDebtType: 'loan' |
// 'credit_card', and the same for loanAllocations' `loanId` field. Not
// applied yet — this is a real change to the existing Scenario shape in
// models.ts (not just an addition), so flagging it as its own decision
// rather than silently redefining it here.
export type WhatIfScenario = Scenario

// ── Summary page view state ─────────────────────────────────────────────
// Not persisted app data — this is the shape of the Summary page's local
// UI state, included here because the doc spells out specific toggle
// behaviour that the data layer needs to support (Section 4.1, Running
// Balance Engine row):
//  - grouping: list vs category, same as today's Bills page
//  - order: 'date' (ascending, next due first, cleared items collapsed
//    below) vs 'amount' — running balance column only shows when
//    grouping='list' AND order='date'
//  - horizon: 'current_month' vs 'next_3_months' (current + 2 ahead,
//    using default/recurring salary and bills to fill the unresolved
//    future) — affects everything on the page EXCEPT the pie charts,
//    which always reflect actuals regardless of this toggle.
// None of grouping/order/horizon apply when a credit-card deck card is
// active — see SummaryCardKind below.

export interface SummaryViewState {
  grouping: 'list' | 'category'
  order: 'date' | 'amount'
  horizon: 'current_month' | 'next_3_months'
}

// ── Summary page swipeable deck ─────────────────────────────────────────
// The deck is no longer a fixed 3 cards. Card presence is derived, not
// stored (doc addendum):
//  - 'personal'   — always present, one per... actually one per viewer,
//                   see note below.
//  - 'joint'      — present only if people.length >= 2 AND at least one
//                   joint-location RecurringTemplate, Loan, or CreditCard
//                   exists. (Reading "bill" broadly here — flag if you
//                   meant literal Bills only.)
//  - 'household'  — present only if people.length >= 2.
//  - 'credit_card'          — one per active CreditCard, always present
//                               per card regardless of salary count.
//  - 'credit_cards_combined' — present only if there is more than one
//                               active CreditCard; pages between them,
//                               separate from the individual cards above.
// Individual and combined credit-card cards suppress the grouping/order
// controls entirely and show a single pie chart (total paid vs total
// outstanding) below the payment list, instead of the category/list
// breakdown the other card kinds show.

export type SummaryCardKind = 'personal' | 'joint' | 'household' | 'credit_card' | 'credit_cards_combined'

export interface SummaryDeckCard {
  kind: SummaryCardKind
  // Only set when kind === 'credit_card' — which card this entry is for.
  creditCardId?: string
}

// ── Root data object ─────────────────────────────────────────────────────

export interface AppDataV2 {
  people: Person[]
  categories: Category[]
  recurringTemplates: RecurringTemplate[]
  loans: Loan[]
  creditCards: CreditCard[]
  transactions: Transaction[]
  payCycles: PayCycleConfig[] // one per person
  scenarios: WhatIfScenario[]
  primaryPersonId: string
}
