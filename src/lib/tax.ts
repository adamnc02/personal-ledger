// UK tax engine — rates confirmed for the 2026/27 tax year (6 Apr 2026 – 5 Apr 2027).
// Sources: HMRC "Rates and thresholds for employers 2026 to 2027", House of Commons
// Library "Direct taxes: Rates and allowances for 2026/27".
//
// This is a take-home-pay estimator, not a payroll engine. It calculates on an
// annual-divided-by-periods basis, whereas real PAYE payroll uses HMRC's
// cumulative period-by-period tables — so expect results within pennies of a
// real payslip, not necessarily identical to it. It also doesn't model things
// like multiple jobs, benefits in kind, marriage allowance, or SIPP/self-assessment
// reclaims on higher/additional-rate pension relief.

export type StudentLoanPlan = 'none' | 'plan1' | 'plan2' | 'plan4' | 'plan5' | 'postgrad'
export type PayFrequency = 'monthly' | 'four_weekly'

// How a deduction affects the calculation, matching real payroll categories:
//  - salary_sacrifice: comes off gross before BOTH tax and NI are calculated
//    (a genuine reduction in contractual pay, e.g. pension via sacrifice,
//    Cycle to Work, a Holiday Purchase Scheme)
//  - net_pay: comes off gross before tax only — NI is still charged on the
//    full gross (a "net pay arrangement" pension)
//  - relief_at_source: comes off net pay, after tax/NI/student loan are
//    calculated on the full gross (a relief-at-source pension; the pension
//    provider claims basic-rate relief separately, not modelled here)
//  - post_tax: comes off net pay, no effect on any calculation at all (e.g.
//    a workplace lottery, a charity deduction, an season ticket loan repayment)
export type DeductionType = 'salary_sacrifice' | 'net_pay' | 'relief_at_source' | 'post_tax'
export type DeductionAmountType = 'fixed' | 'percent'

export interface SalaryDeduction {
  id: string
  name: string
  type: DeductionType
  amountType: DeductionAmountType
  // £ per pay period if amountType is 'fixed', or % of gross per period if 'percent'.
  // Percentage deductions are always calculated against the original gross for the
  // period, not a running total after earlier deductions — matches how real payslips
  // compute each percentage-based line independently.
  amount: number
}

export interface TaxYearConstants {
  personalAllowance: number
  personalAllowanceTaperStart: number
  personalAllowanceTaperEnd: number
  basicRateLimit: number // upper bound of basic rate band (England/Wales/NI)
  higherRateLimit: number // upper bound of higher rate band
  basicRate: number
  higherRate: number
  additionalRate: number
  niPrimaryThreshold: number
  niUpperEarningsLimit: number
  niMainRate: number
  niUpperRate: number
}

export const TAX_YEAR_2026_27: TaxYearConstants = {
  personalAllowance: 12570,
  personalAllowanceTaperStart: 100000,
  personalAllowanceTaperEnd: 125140,
  basicRateLimit: 50270,
  higherRateLimit: 125140,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  niPrimaryThreshold: 12570,
  niUpperEarningsLimit: 50270,
  niMainRate: 0.08,
  niUpperRate: 0.02,
}

export const STUDENT_LOAN_THRESHOLDS_2026_27: Record<Exclude<StudentLoanPlan, 'none'>, { threshold: number; rate: number }> = {
  plan1: { threshold: 26900, rate: 0.09 },
  plan2: { threshold: 29385, rate: 0.09 },
  plan4: { threshold: 33795, rate: 0.09 },
  plan5: { threshold: 25000, rate: 0.09 },
  postgrad: { threshold: 21000, rate: 0.06 },
}

export interface TaxCodeResult {
  allowance: number
  flatRate: 'BR' | 'D0' | 'D1' | 'NT' | null
  isKCode: boolean
}

/** Parses a UK tax code into an effective allowance (or flat-rate instruction). */
export function parseTaxCode(code: string): TaxCodeResult {
  const c = code.trim().toUpperCase()

  if (c === 'BR') return { allowance: 0, flatRate: 'BR', isKCode: false }
  if (c === 'D0') return { allowance: 0, flatRate: 'D0', isKCode: false }
  if (c === 'D1') return { allowance: 0, flatRate: 'D1', isKCode: false }
  if (c === 'NT') return { allowance: 0, flatRate: 'NT', isKCode: false }

  if (c.startsWith('K')) {
    const num = parseInt(c.slice(1), 10)
    return { allowance: isNaN(num) ? 0 : -(num * 10), flatRate: null, isKCode: true }
  }

  const match = c.match(/^(\d+)[LMN T]?$/)
  if (match) {
    return { allowance: parseInt(match[1], 10) * 10, flatRate: null, isKCode: false }
  }

  if (c === '0T') return { allowance: 0, flatRate: null, isKCode: false }

  return { allowance: TAX_YEAR_2026_27.personalAllowance, flatRate: null, isKCode: false }
}

/** Personal allowance after the £100k taper, before applying tax-code overrides. */
export function taperedPersonalAllowance(
  adjustedNetIncome: number,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): number {
  if (adjustedNetIncome <= constants.personalAllowanceTaperStart) return constants.personalAllowance
  const reduction = Math.floor((adjustedNetIncome - constants.personalAllowanceTaperStart) / 2)
  return Math.max(0, constants.personalAllowance - reduction)
}

export interface IncomeTaxBreakdown {
  totalTax: number
  bands: { label: string; amount: number; rate: number; tax: number }[]
  allowanceUsed: number
}

/** Income tax for England, Wales & Northern Ireland taxpayers. */
export function calculateIncomeTaxEWNI(
  taxableIncomeBeforeAllowance: number,
  allowance: number,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): IncomeTaxBreakdown {
  const taxable = Math.max(0, taxableIncomeBeforeAllowance - allowance)
  const bands: IncomeTaxBreakdown['bands'] = []

  const basicBandSize = constants.basicRateLimit - constants.personalAllowance
  const higherBandSize = constants.higherRateLimit - constants.basicRateLimit

  const basicAmount = Math.min(taxable, basicBandSize)
  const higherAmount = Math.min(Math.max(0, taxable - basicBandSize), higherBandSize)
  const additionalAmount = Math.max(0, taxable - basicBandSize - higherBandSize)

  bands.push({ label: 'Basic rate (20%)', amount: basicAmount, rate: constants.basicRate, tax: basicAmount * constants.basicRate })
  bands.push({ label: 'Higher rate (40%)', amount: higherAmount, rate: constants.higherRate, tax: higherAmount * constants.higherRate })
  bands.push({ label: 'Additional rate (45%)', amount: additionalAmount, rate: constants.additionalRate, tax: additionalAmount * constants.additionalRate })

  const totalTax = bands.reduce((sum, b) => sum + b.tax, 0)
  return { totalTax, bands, allowanceUsed: allowance }
}

export function calculateNationalInsurance(
  grossAnnual: number,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): { total: number; mainRateAmount: number; upperRateAmount: number } {
  const mainBand = Math.max(0, Math.min(grossAnnual, constants.niUpperEarningsLimit) - constants.niPrimaryThreshold)
  const upperBand = Math.max(0, grossAnnual - constants.niUpperEarningsLimit)
  const mainRateAmount = Math.max(0, mainBand) * constants.niMainRate
  const upperRateAmount = upperBand * constants.niUpperRate
  return { total: mainRateAmount + upperRateAmount, mainRateAmount, upperRateAmount }
}

export function calculateStudentLoanRepayment(grossAnnual: number, plan: StudentLoanPlan): number {
  if (plan === 'none') return 0
  const { threshold, rate } = STUDENT_LOAN_THRESHOLDS_2026_27[plan]
  return Math.max(0, grossAnnual - threshold) * rate
}

export interface SalaryInput {
  grossAnnual: number
  taxCode: string
  studentLoanPlan: StudentLoanPlan
  payFrequency: PayFrequency
  deductions: SalaryDeduction[]
  employerPensionPercent?: number // informational only — doesn't affect your own take-home
}

export interface DeductionResult {
  id: string
  name: string
  type: DeductionType
  amountPerPeriod: number
  runningTotalAfter: number
}

export interface SalaryBreakdown {
  grossAnnual: number
  periodsPerYear: number
  grossPerPeriod: number
  // Deductions that reduce tax/NI before they're calculated (salary_sacrifice, net_pay)
  preTaxDeductions: DeductionResult[]
  grossTaxablePerPeriod: number
  grossNiablePerPeriod: number
  incomeTaxPerPeriod: number
  nationalInsurancePerPeriod: number
  studentLoanPerPeriod: number
  // Deductions taken from net pay, no effect on tax/NI (relief_at_source, post_tax)
  postTaxDeductions: DeductionResult[]
  netPerPeriod: number
  netAnnual: number
  netMonthly: number // always annual/12, a standard reference figure
  netWeekly: number
  employerPensionContributionPerPeriod: number
  personalAllowance: number
  taxBreakdown: IncomeTaxBreakdown
}

/**
 * Annual income tax for a given annual TAXABLE gross (i.e. already net of
 * any salary-sacrifice / net-pay deductions) under a given tax code.
 *
 * Extracted out of calculateNetSalary so it can be called twice against
 * two different taxable figures — which is exactly what working out the
 * marginal tax on a bonus requires (see calculateBonusOnTop). Previously
 * this whole flat-rate/banded decision lived inline in calculateNetSalary
 * and was unreachable from anywhere else, which is why the bonus
 * calculation had to resort to re-running the ENTIRE salary calculation
 * with an inflated grossAnnual — the thing that made it wrong.
 */
export function annualIncomeTaxFor(annualTaxableGross: number, taxCode: string, constants: TaxYearConstants = TAX_YEAR_2026_27): IncomeTaxBreakdown {
  const taxCodeResult = parseTaxCode(taxCode)
  if (taxCodeResult.flatRate === 'NT') return { totalTax: 0, bands: [], allowanceUsed: 0 }
  if (taxCodeResult.flatRate === 'BR') {
    const tax = annualTaxableGross * constants.basicRate
    return { totalTax: tax, bands: [{ label: 'Basic rate (20%, BR code)', amount: annualTaxableGross, rate: constants.basicRate, tax }], allowanceUsed: 0 }
  }
  if (taxCodeResult.flatRate === 'D0') {
    const tax = annualTaxableGross * constants.higherRate
    return { totalTax: tax, bands: [{ label: 'Higher rate (40%, D0 code)', amount: annualTaxableGross, rate: constants.higherRate, tax }], allowanceUsed: 0 }
  }
  if (taxCodeResult.flatRate === 'D1') {
    const tax = annualTaxableGross * constants.additionalRate
    return { totalTax: tax, bands: [{ label: 'Additional rate (45%, D1 code)', amount: annualTaxableGross, rate: constants.additionalRate, tax }], allowanceUsed: 0 }
  }
  const allowance = Math.max(0, Math.min(taperedPersonalAllowance(annualTaxableGross, constants), taxCodeResult.allowance))
  return calculateIncomeTaxEWNI(annualTaxableGross, allowance, constants)
}

function resolveAmount(deduction: SalaryDeduction, grossPerPeriod: number): number {
  return deduction.amountType === 'percent' ? (deduction.amount / 100) * grossPerPeriod : deduction.amount
}

/** Full net-salary calculation, walking through a person's own ordered list of deductions. */
export function calculateNetSalary(input: SalaryInput, constants: TaxYearConstants = TAX_YEAR_2026_27): SalaryBreakdown {
  const periodsPerYear = input.payFrequency === 'four_weekly' ? 13 : 12
  const grossPerPeriod = input.grossAnnual / periodsPerYear

  const deductions = input.deductions ?? []

  // --- Phase 1: deductions that affect tax/NI, in the order given ---
  let runningTotal = grossPerPeriod
  let taxableGrossPerPeriod = grossPerPeriod
  let niableGrossPerPeriod = grossPerPeriod
  const preTaxDeductions: DeductionResult[] = []

  for (const d of deductions) {
    if (d.type !== 'salary_sacrifice' && d.type !== 'net_pay') continue
    const amount = resolveAmount(d, grossPerPeriod)
    runningTotal -= amount
    taxableGrossPerPeriod -= amount
    if (d.type === 'salary_sacrifice') niableGrossPerPeriod -= amount
    preTaxDeductions.push({ id: d.id, name: d.name, type: d.type, amountPerPeriod: amount, runningTotalAfter: runningTotal })
  }

  // --- Phase 2: tax, NI, student loan on the reduced figures ---
  const annualTaxableGross = taxableGrossPerPeriod * periodsPerYear
  const taxBreakdown = annualIncomeTaxFor(annualTaxableGross, input.taxCode, constants)
  const allowance = taxBreakdown.allowanceUsed

  const incomeTaxPerPeriod = taxBreakdown.totalTax / periodsPerYear
  const ni = calculateNationalInsurance(niableGrossPerPeriod * periodsPerYear, constants)
  const nationalInsurancePerPeriod = ni.total / periodsPerYear
  // Student loan is calculated on the post-salary-sacrifice gross, matching how
  // HMRC actually applies it for salary sacrifice arrangements.
  const studentLoanPerPeriod = calculateStudentLoanRepayment(annualTaxableGross, input.studentLoanPlan) / periodsPerYear

  runningTotal -= incomeTaxPerPeriod + nationalInsurancePerPeriod + studentLoanPerPeriod

  // --- Phase 3: deductions taken from net pay, no effect on tax/NI ---
  const postTaxDeductions: DeductionResult[] = []
  for (const d of deductions) {
    if (d.type !== 'relief_at_source' && d.type !== 'post_tax') continue
    const amount = resolveAmount(d, grossPerPeriod)
    runningTotal -= amount
    postTaxDeductions.push({ id: d.id, name: d.name, type: d.type, amountPerPeriod: amount, runningTotalAfter: runningTotal })
  }

  const netPerPeriod = runningTotal
  const netAnnual = netPerPeriod * periodsPerYear
  const employerPensionContributionPerPeriod = ((input.employerPensionPercent ?? 0) / 100) * grossPerPeriod

  return {
    grossAnnual: input.grossAnnual,
    periodsPerYear,
    grossPerPeriod,
    preTaxDeductions,
    grossTaxablePerPeriod: taxableGrossPerPeriod,
    grossNiablePerPeriod: niableGrossPerPeriod,
    incomeTaxPerPeriod,
    nationalInsurancePerPeriod,
    studentLoanPerPeriod,
    postTaxDeductions,
    netPerPeriod,
    netAnnual,
    netMonthly: netAnnual / 12,
    netWeekly: netAnnual / 52,
    employerPensionContributionPerPeriod,
    personalAllowance: allowance,
    taxBreakdown,
  }
}

// ── Bonus ───────────────────────────────────────────────────────────────

export interface BonusBreakdown {
  grossBonus: number
  incomeTax: number
  nationalInsurance: number
  /** Always 0 — a bonus is not charged student loan (see calculateBonusOnTop). Present for shape stability, not because it varies. */
  studentLoan: number
  /** grossBonus less income tax and NI. Always equals grossBonus - incomeTax - nationalInsurance, since studentLoan above is fixed at 0. */
  net: number
}

/**
 * The net value of a one-off GROSS bonus paid on top of this salary.
 *
 * A bonus is treated as TAXABLE and NIABLE, and nothing else: none of the
 * person's standing deductions are applied to it, and neither is student
 * loan. That's a
 * deliberate correction of how this used to work. The previous approach
 * recomputed the whole year with `grossAnnual + bonus` and took the
 * difference in net pay — which quietly ran the bonus through every
 * percentage-based deduction as well. With a 12.5% salary-sacrifice
 * pension, a £1,000 bonus lost £125 to the pension before tax was even
 * considered, and the figure shown as "net bonus" was £455 instead of
 * £520. Fixed deductions (a £70.39 holiday-buy line, a £10 charity line)
 * were unaffected either way — it was specifically the percentage ones
 * that scaled with the inflated gross.
 *
 * Marginal, not average: tax and NI are each computed twice — once on the
 * ordinary annual figure, once with the bonus added — and the DIFFERENCE
 * is what the bonus costs. That's what correctly charges a bonus that
 * straddles a band boundary at the right rates on each part, and picks up
 * the personal-allowance taper if the bonus pushes total income past
 * £100k.
 *
 * The two bases are deliberately different: income tax builds on
 * `grossTaxablePerPeriod` (net of salary_sacrifice AND net_pay
 * deductions), NI on `grossNiablePerPeriod` (net of salary_sacrifice
 * only) — the same split calculateNetSalary already uses, so a bonus is
 * charged against exactly the same starting figures the salary itself is.
 *
 * Student loan is deliberately NOT charged on a bonus — confirmed
 * explicitly: tax and NI are the only two things that touch it. The
 * `studentLoan` field below is therefore always 0. It's kept on the
 * result rather than deleted so the breakdown has a fixed shape and any
 * future change of mind is a one-line edit here rather than a change to
 * every caller's type. The person's ordinary salary is still charged
 * student loan as normal by calculateNetSalary — this only concerns the
 * bonus sitting on top of it.
 */
export function calculateBonusOnTop(input: SalaryInput, grossBonus: number, constants: TaxYearConstants = TAX_YEAR_2026_27): BonusBreakdown {
  if (!(grossBonus > 0)) return { grossBonus: 0, incomeTax: 0, nationalInsurance: 0, studentLoan: 0, net: 0 }

  const base = calculateNetSalary(input, constants)
  const annualTaxable = base.grossTaxablePerPeriod * base.periodsPerYear
  const annualNiable = base.grossNiablePerPeriod * base.periodsPerYear

  const incomeTax =
    annualIncomeTaxFor(annualTaxable + grossBonus, input.taxCode, constants).totalTax - annualIncomeTaxFor(annualTaxable, input.taxCode, constants).totalTax

  const nationalInsurance = calculateNationalInsurance(annualNiable + grossBonus, constants).total - calculateNationalInsurance(annualNiable, constants).total

  const studentLoan = 0

  const net = grossBonus - incomeTax - nationalInsurance
  return { grossBonus, incomeTax, nationalInsurance, studentLoan, net }
}
