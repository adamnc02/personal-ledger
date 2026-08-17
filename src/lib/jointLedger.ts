// Joint cost-splitting, ported to the ledger model (closes the gap
// explicitly flagged in projection.ts and Home.tsx's Joint/Household
// placeholders). Two things live here:
//  - personShareOfJointAmount: the actual split math, shared by both use
//    sites below.
//  - generateJointContributionTransactions: synthetic, personal-scoped
//    transactions representing ONE person's share of every joint bill/
//    loan occurrence — folded into that person's own projection, so a
//    joint bill genuinely reduces their personal balance by their share
//    (same idea as the pre-rebuild app's jointContribution figure, which
//    got folded into the Personal card's own total).
//  - computeJointSummary: the Joint card's own view — full joint amounts
//    (not split), plus a per-person contribution breakdown.
//
// ASSUMPTION, same one the pre-rebuild app made: every joint item splits
// between exactly two people (payee + "the other one"), since payee/
// payeeSharePercent is a two-way split by construction (SplitEditor only
// ever offers two people). A household with 3+ people isn't modelled.

import { generateTransactionsForTemplate } from './schedule'
import { generateLoanPaymentTransactions } from './ledgerLoans'
import type { AppDataV2, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/** This person's share of a joint amount, given who the nominal payee is and their share percent. */
export function personShareOfJointAmount(amount: number, payee: string, payeeSharePercent: number, personId: string): number {
  const percent = personId === payee ? payeeSharePercent : 100 - payeeSharePercent
  return round2(amount * (percent / 100))
}

/**
 * This person's SHARE of every joint recurring-bill/loan occurrence in
 * the range, as synthetic transactions tagged to their own personal
 * account (location: 'personal', ownerId: personId) — not real ledger
 * entries, purely for folding into their own projection.
 */
export function generateJointContributionTransactions(data: AppDataV2, personId: string, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const results: Omit<Transaction, 'id'>[] = []

  for (const template of data.recurringTemplates.filter((t) => t.location === 'joint')) {
    for (const occ of generateTransactionsForTemplate(template, rangeStart, rangeEnd)) {
      const share = personShareOfJointAmount(occ.amount, template.payee, template.payeeSharePercent, personId)
      if (share <= 0) continue
      results.push({ ...occ, amount: share, location: 'personal', ownerId: personId, note: `Your share of ${template.name}` })
    }
  }

  for (const loan of data.loans.filter((l) => l.location === 'joint')) {
    for (const occ of generateLoanPaymentTransactions(loan, rangeStart, rangeEnd)) {
      const share = personShareOfJointAmount(occ.amount, loan.payee, loan.payeeSharePercent, personId)
      if (share <= 0) continue
      results.push({ ...occ, amount: share, location: 'personal', ownerId: personId, note: `Your share of ${loan.name}` })
    }
  }

  return results
}

export interface JointSummary {
  totalOutgoings: number // full, unsplit joint amounts due in the range
  perPerson: { personId: string; name: string; amount: number }[] // each person's share of that same total
  items: { name: string; amount: number; date: string }[] // individual joint occurrences, for display
}

/** The Joint card's own view: full joint costs, plus who owes what share — the shared account's own picture, distinct from anyone's personal balance. */
export function computeJointSummary(data: AppDataV2, rangeStart: Date, rangeEnd: Date): JointSummary {
  const items: { name: string; amount: number; date: string; payee: string; payeeSharePercent: number }[] = []

  for (const template of data.recurringTemplates.filter((t) => t.location === 'joint')) {
    for (const occ of generateTransactionsForTemplate(template, rangeStart, rangeEnd)) {
      items.push({ name: template.name, amount: occ.amount, date: occ.date, payee: template.payee, payeeSharePercent: template.payeeSharePercent })
    }
  }
  for (const loan of data.loans.filter((l) => l.location === 'joint')) {
    for (const occ of generateLoanPaymentTransactions(loan, rangeStart, rangeEnd)) {
      items.push({ name: loan.name, amount: occ.amount, date: occ.date, payee: loan.payee, payeeSharePercent: loan.payeeSharePercent })
    }
  }

  const totalOutgoings = round2(items.reduce((sum, i) => sum + i.amount, 0))
  const perPerson = data.people.map((p) => ({
    personId: p.id,
    name: p.name,
    amount: round2(items.reduce((sum, i) => sum + personShareOfJointAmount(i.amount, i.payee, i.payeeSharePercent, p.id), 0)),
  }))

  return { totalOutgoings, perPerson, items: items.map(({ name, amount, date }) => ({ name, amount, date })) }
}

/** Every person's share should sum back to the full total (within rounding slack). The single most important property this file needs to hold — exported so tests can check it directly against arbitrary data rather than hand-deriving the expected total. */
export function jointSharesReconcile(summary: JointSummary): boolean {
  const summed = round2(summary.perPerson.reduce((sum, p) => sum + p.amount, 0))
  return Math.abs(summed - summary.totalOutgoings) <= 0.05
}
