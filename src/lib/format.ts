/** £ amounts throughout the app — comma thousand separators, always 2 decimal places. Use as `£${formatCurrency(x)}`, not a leading £ built in, to match the existing inline-£ convention every call site already uses. */
export function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
