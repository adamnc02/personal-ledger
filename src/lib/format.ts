/** £ amounts throughout the app — comma thousand separators, always 2 decimal places. Use as `£${formatCurrency(x)}`, not a leading £ built in, to match the existing inline-£ convention every call site already uses. */
export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "March 2028" from an ISO date — used wherever a loan payoff date is shown as a rough milestone rather than an exact day (e.g. an overpayment recast preview, the loan ledger modal's finish-date banner, scope §10). Parses the ISO string's own date components directly rather than `new Date(iso)` + local getters, so this can never day-shift across a timezone boundary the way constructing a Date from a bare date-only string can. */
export function formatMonthYear(iso: string): string {
  const [year, month] = iso.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}
