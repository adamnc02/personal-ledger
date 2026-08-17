import type { PayFrequency, SalaryDeduction, StudentLoanPlan } from '../lib/tax'

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
}

export interface LoanPayment {
  date: string // ISO date
  amount: number
  balanceAfter: number
}

export type ScenarioActionType =
  | 'sell_asset'
  | 'pay_off_loan' // one-off lump sum toward a loan
  | 'new_bill' // a new (or changed) simple recurring monthly cost, not linked to a loan
  | 'new_finance_agreement' // a new loan-like recurring cost, computed from amount/APR/term
  | 'exclude_loan' // simulate as if a loan's monthly cost didn't count at all
  | 'loan_overpayment' // a recurring extra amount on top of a loan's normal payment
  | 'salary_change' // hypothetical new gross annual salary, for a chosen person
  | 'savings_lump_sum' // one-off lump sum toward a savings goal

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
    linkedLoanId?: string // single-loan target for exclude_loan/loan_overpayment, or legacy sell_asset/pay_off_loan data
    loanAllocations?: { loanId: string; amount?: number }[] // ordered multi-loan target for sell_asset/pay_off_loan. Cascades in order, clearing each as far as possible; `amount` omitted means "auto — take whatever's left in the pool", set means "exactly this much, no more"
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
  scenarios: Scenario[]
  // which person's "personal" view is currently active (the app's owner/user)
  primaryPersonId: string
}
