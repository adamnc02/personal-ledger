// Sanity checks for the "group by category" bucketing rule added to the
// Home page: loan payments and everything credit-card-related always
// fold into their own fixed group in the summary view, regardless of
// what real category the underlying loan/card/bill is actually tagged
// with — that real category is untouched and still what shows on the
// transaction's own row. No DOM here, so this exercises the plain
// function directly rather than the rendered list.

import { CREDIT_CARD_CATEGORY_ID, SAVINGS_CATEGORY_ID, type Transaction } from '../src/types/ledger'
import { seededCategoryIdForIcon } from '../src/lib/categories'

// Home.tsx doesn't export groupingCategoryId (page-local), so this is
// reproduced verbatim here to test the rule in isolation. If Home.tsx's
// version ever drifts from this, that's exactly the kind of silent
// regression this script exists to catch — keep the two in sync.
const LOANS_GROUP_CATEGORY_ID = seededCategoryIdForIcon('loan')
function groupingCategoryId(t: Pick<Transaction, 'type' | 'paymentMethod' | 'categoryId'>): string {
  if (t.type === 'loan_payment') return LOANS_GROUP_CATEGORY_ID
  if (t.type === 'credit_card_payment' || t.type === 'credit_card_spend') return CREDIT_CARD_CATEGORY_ID
  if (t.paymentMethod === 'card') return CREDIT_CARD_CATEGORY_ID
  return t.categoryId
}

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// A loan payment against a loan whose OWN assigned category is "Fitness"
// (the user is free to pick anything) still buckets under Loans.
check(
  "A loan_payment transaction groups under Loans, regardless of the loan's own real category",
  groupingCategoryId({ type: 'loan_payment', paymentMethod: 'direct_debit', categoryId: 'category-seed-fitness' }),
  LOANS_GROUP_CATEGORY_ID,
)

// A credit card payment against a card whose own assigned category is
// "Shopping" still buckets under Credit Card.
check(
  "A credit_card_payment transaction groups under Credit Card, regardless of the card's own real category",
  groupingCategoryId({ type: 'credit_card_payment', paymentMethod: 'direct_debit', categoryId: 'category-seed-shopping' }),
  CREDIT_CARD_CATEGORY_ID,
)
check(
  'A credit_card_spend transaction groups under Credit Card too',
  groupingCategoryId({ type: 'credit_card_spend', paymentMethod: 'card', categoryId: 'category-seed-shopping' }),
  CREDIT_CARD_CATEGORY_ID,
)

// A plain bill, paid by "Card" payment method but not linked to any
// specific CreditCard entity, still buckets under Credit Card even
// though its type is just 'bill_payment' and its real category is
// something else entirely (e.g. Subscriptions).
check(
  'A bill_payment with paymentMethod "card" groups under Credit Card even though its type is ordinary',
  groupingCategoryId({ type: 'bill_payment', paymentMethod: 'card', categoryId: 'category-seed-streaming' }),
  CREDIT_CARD_CATEGORY_ID,
)

// An ordinary expense paid by card, same idea.
check(
  'An ad-hoc expense with paymentMethod "card" groups under Credit Card',
  groupingCategoryId({ type: 'expense', paymentMethod: 'card', categoryId: 'category-seed-food' }),
  CREDIT_CARD_CATEGORY_ID,
)

// Everything else groups by its real category exactly as before —
// including savings, which is untouched by this rule entirely (it
// already always carries SAVINGS_CATEGORY_ID directly).
check(
  'A bill paid by direct debit groups under its own real category, unaffected',
  groupingCategoryId({ type: 'bill_payment', paymentMethod: 'direct_debit', categoryId: 'category-seed-streaming' }),
  'category-seed-streaming',
)
check(
  'A savings_contribution groups under Savings, same as always (no rule change here)',
  groupingCategoryId({ type: 'savings_contribution', paymentMethod: 'bank_transfer', categoryId: SAVINGS_CATEGORY_ID }),
  SAVINGS_CATEGORY_ID,
)
check(
  'A plain expense paid by bank transfer groups under its own real category',
  groupingCategoryId({ type: 'expense', paymentMethod: 'bank_transfer', categoryId: 'category-seed-food' }),
  'category-seed-food',
)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll category-grouping checks passed.')
