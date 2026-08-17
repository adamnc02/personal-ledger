export interface FinanceAgreementInput {
  borrowAmount: number
  aprPercent: number // used for the actual repayment calculation
  termMonths: number
}

export interface FinanceAgreementResult {
  monthlyPayment: number
  totalRepayable: number
  totalInterest: number
}

/**
 * Standard amortising-loan calculation: a fixed monthly payment that clears
 * the borrowed amount plus interest over the given term. Uses APR (rather
 * than a separate nominal "interest rate") as the actual cost driver, since
 * APR is the standardised figure meant for comparing credit costs — a
 * simplification of compounding, but the same one most consumer finance
 * calculators use.
 */
export function calculateFinanceAgreement(input: FinanceAgreementInput): FinanceAgreementResult {
  const { borrowAmount, aprPercent, termMonths } = input

  if (borrowAmount <= 0 || termMonths <= 0) {
    return { monthlyPayment: 0, totalRepayable: 0, totalInterest: 0 }
  }

  const monthlyRate = aprPercent / 100 / 12

  const monthlyPayment =
    monthlyRate > 0 ? (borrowAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths)) : borrowAmount / termMonths

  const totalRepayable = round2(monthlyPayment * termMonths)

  return {
    monthlyPayment: round2(monthlyPayment),
    totalRepayable,
    totalInterest: round2(totalRepayable - borrowAmount),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
