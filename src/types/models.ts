import type { PayFrequency, SalaryDeduction, StudentLoanPlan } from '../lib/tax'
import type { CreditCard } from './ledger'

export interface SavingsEntry {
  id: string
  type: 'goal' | 'plan'
  name: string
  includeInSummary: boolean // whether this counts against "Available" balance
  // 'goal' fields — a target to save toward
  targetAmount?: number
  currentAmount?: number
  targetDate?: string // ISO date, optional
  // 'plan' fields — a flat recurring commitment, no target
  monthlyAmount?: number
}

export interface Person {
  id: string
  name: string
  color: string // accent color used for "their" data throughout the UI
  salary: {
    grossAnnual: number
    taxCode: string
    studentLoanPlan: StudentLoanPlan
    payFrequency: PayFrequency
    deductions: SalaryDeduction[] // ordered — applied in payroll order, see lib/tax.ts
    employerPensionPercent?: number // informational only, doesn't affect take-home
  }
  savingsEntries: SavingsEntry[]
}

export type BillLocation = 'personal' | 'joint'

export interface Bill {
  id: string
  name: string
  cost: number
  dueDay: number // 1–31, day of month
  location: BillLocation
  // For joint bills: `payee` is the person this percentage is assigned to;
  // `payeeSharePercent` (0-100) is their share of the cost. The remainder is
  // split evenly across everyone else. 100 = fully theirs, 50 = even split.
  // Not used for personal bills.
  payee: string
  payeeSharePercent: number
  category: string
  ownerId: string // whose "personal" account it belongs to when location = 'personal'
  isStandingOrder: boolean
  icon?: string // key into the built-in icon library, see lib/billIcons.ts
  iconColor?: string // hex color for the icon
}

export interface Loan {
  id: string
  name: string
  firstPaymentDate: string // ISO date
  totalAmount: number
  monthlyPayment: number
  icon?: string // key into the built-in icon library, see lib/billIcons.ts
  iconColor?: string // hex color for the icon
  // Loans behave like an automatic recurring bill: their current monthly
  // payment counts toward personal/joint totals using the same split rules
  // as a Bill, without needing a separate duplicate bill entry.
  location: BillLocation
  ownerId: string // whose personal account it belongs to, when location = 'personal'
  payee: string // for joint loans: who the percentage below is assigned to
  payeeSharePercent: number // for joint loans: their share, 0-100

  // ── Amortisation-engine bridge fields (loan-amortisation-engine scope
  // §1/handoff) ────────────────────────────────────────────────────────
  // A loan reaching this shape via legacyBridge.ts (the only real
  // producer of these in the live app — see legacyBridge.ts's own
  // header) always carries a real, resolved monthlyRate (calibrated, or
  // the back-solved baseline — resolveLoanRateAndConvention in
  // ledgerLoans.ts never returns undefined). These three fields are how
  // that gets carried through the bridge, so lib/loans.ts's engine can
  // delegate to the SAME real amortisation maths for its forward
  // simulations, instead of maintaining a second, parallel flat-only
  // implementation that would silently drift from the real one over
  // time. All three stay undefined for any Loan that never went through
  // the bridge (there are none reachable in the live routed app today,
  // but test fixtures construct these directly) — lib/loans.ts falls
  // back to its original flat, interest-free arithmetic whenever
  // calibratedMonthlyRate is absent, unchanged from before this field
  // existed.
  calibratedMonthlyRate?: number
  interestConventionId?: string
  settlementMultiplier?: number
}

export interface LoanPayment {
  date: string // ISO date
  amount: number
  balanceAfter: number
}

export type ScenarioActionType =
  | 'sell_asset'
  | 'pay_off_loan' // one-off lump sum toward a loan or credit card
  | 'new_bill' // a new (or changed) simple recurring monthly cost, not linked to a loan
  | 'new_finance_agreement' // a new loan-like recurring cost, computed from amount/APR/term
  | 'exclude_loan' // simulate as if a loan or credit card's monthly cost didn't count at all
  | 'loan_overpayment' // a recurring extra amount on top of a loan or credit card's normal payment
  | 'salary_change' // hypothetical new gross annual salary, for a chosen person
  | 'savings_lump_sum' // one-off lump sum toward a savings goal
  | 'purchase' // buying a one-off thing on a specific DATE — see purchaseImpact.ts

// What kind of real thing a scenario action's target points at — a loan or
// a credit card. Both are valid targets for pay_off_loan/exclude_loan/
// loan_overpayment; kept as a named union rather than a boolean since a
// third kind is more likely to show up over time than a flip to boolean
// ever being reversed.
export type ScenarioTargetKind = 'loan' | 'credit_card'

export interface Scenario {
  id: string
  name: string
  description?: string
  includeInCumulative: boolean
  actions: {
    id: string
    type: ScenarioActionType
    label: string
    value: number // sale proceeds, purchase cost, extra/overpayment amount, new gross salary, or the computed monthly cost for new_bill/new_finance_agreement
    // Single-target actions (exclude_loan, loan_overpayment): which loan or
    // credit card this action points at.
    linkedTargetKind?: ScenarioTargetKind
    linkedTargetId?: string
    /** @deprecated Superseded by linkedTargetKind/linkedTargetId — kept only so scenarios saved before credit-card targets existed keep working. Always loan-kind when present. */
    linkedLoanId?: string
    // Multi-target actions (sell_asset, pay_off_loan): an ordered, mixed
    // loan/credit-card cascade. Clears each target as far as possible in
    // order; `amount` omitted means "auto — take whatever's left in the
    // pool", set means "exactly this much, no more".
    targets?: { kind: ScenarioTargetKind; id: string; amount?: number }[]
    /** @deprecated Superseded by `targets` — kept only so scenarios saved before credit-card targets existed keep working. Always loan-kind when present. */
    loanAllocations?: { loanId: string; amount?: number }[]
    // Used by 'purchase' only — the date the money actually leaves the
    // account. Unlike every other action type, a purchase is anchored to
    // a real calendar date rather than being a shapeless "one-off": the
    // whole point is to see the balance ON that day, so the date is part
    // of the action rather than something the summary infers.
    purchaseDate?: string // ISO date
    personId?: string // for 'salary_change' and 'savings_lump_sum' — whose salary/goal this applies to (defaults to the viewer)
    savingsEntryId?: string // for 'savings_lump_sum' — which of that person's savings goals it targets
    // Used by 'new_bill' and 'new_finance_agreement' — where the new cost sits and how it's split
    name?: string
    location?: BillLocation
    ownerId?: string
    payee?: string
    payeeSharePercent?: number
    // Used by 'new_finance_agreement' only — inputs behind the computed monthly value
    borrowAmount?: number
    interestRatePercent?: number // nominal rate, informational
    aprPercent?: number // used for the actual repayment calculation
    termMonths?: number
    totalRepayable?: number // computed: monthly value × termMonths
  }[]
}

export interface AppData {
  people: Person[]
  bills: Bill[]
  loans: Loan[]
  // Real CreditCard entities so scenario actions can target one directly —
  // NOT the same as the minimum-payment-folded-into-bills adaptation
  // legacyBridge also does for baseline monthly totals; that's a separate,
  // unrelated use of the same underlying ledger data. Only active cards are
  // exposed here (see legacyBridge.ts), same filtering convention as the
  // bills-folding step.
  creditCards: CreditCard[]
  scenarios: Scenario[]
  // which person's "personal" view is currently active (the app's owner/user)
  primaryPersonId: string
}
