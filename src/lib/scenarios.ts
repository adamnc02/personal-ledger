import type { AppData, Bill, Loan, Scenario, ScenarioTargetKind } from '../types/models'
import type { CreditCard } from '../types/ledger'
import { summarizeLoan, currentLoanMonthlyCost } from './loans'
import { computeMinimumPaymentAmount, simulateCardPayoffMonths } from './creditCards'
import { costForPerson } from './bills'
import { calculateNetSalary } from './tax'
import { monthlyAmountForEntry, monthsUntil } from './savings'

export interface LoanImpact {
  // Despite the name (kept for minimal disruption to existing call sites),
  // this now covers BOTH loans and credit cards — targetKind says which.
  // loanId/loanName hold the target's real id/name either way.
  loanId: string
  loanName: string
  targetKind: ScenarioTargetKind
  kind: 'payoff' | 'exclude' | 'overpayment'
  originalRemaining: number
  newRemaining: number
  lumpSumApplied: number // 'payoff' only
  overpaymentPerMonth: number // 'overpayment' only
  originalMonthsRemaining: number
  newMonthsRemaining: number
  monthsSaved: number
  fullyPaidOff: boolean
  originalMonthlyCostForPerson: number
  newMonthlyCostForPerson: number
}

export interface SalaryChangeImpact {
  personId: string
  personName: string
  oldNetMonthly: number // actually "per pay period" — named for backward compat, see calculateNetSalary's netPerPeriod
  newNetMonthly: number
  delta: number
}

export interface SavingsLumpSumImpact {
  personName: string
  goalName: string
  lumpSumApplied: number
  originalRemaining: number
  newRemaining: number
  monthsSaved: number
  hasTargetDate: boolean
}

export interface ScenarioImpact {
  oneOffCashImpact: number // one-time proceeds/costs, including any lump sum beyond what a loan/card needed
  monthlyAvailableBefore: number
  monthlyAvailableAfter: number
  monthlyImpact: number // recurring monthly change, from loans, cards, new/cancelled costs, or a salary change
  loanImpacts: LoanImpact[]
  salaryChangeImpact: SalaryChangeImpact | null
  savingsImpacts: SavingsLumpSumImpact[]
}

/** A credit card's monthly cost has no location/split concept (CreditCard.ownerId is the sole owner, always) — so unlike a loan/bill this is either the full amount or nothing, never a partial share. */
function cardMonthlyCostForPerson(card: CreditCard, amount: number, personId: string): number {
  return card.ownerId === personId ? amount : 0
}

/**
 * Calculates the effect of a scenario on a specific person's finances.
 * Handles three shapes of change:
 *  - One-off: a single point-in-time cash gain or cost
 *  - Recurring: an ongoing monthly change (new cost, cancelled cost, salary change)
 *  - Loan/credit-card-specific: paying off (fully/partially), excluding, or overpaying one
 */
export function calculateScenarioImpact(scenario: Scenario, data: AppData, personId: string, monthlyAvailableBefore: number): ScenarioImpact {
  let oneOffCashImpact = 0
  let monthlyImpact = 0
  const loanImpacts: LoanImpact[] = []
  let salaryChangeImpact: SalaryChangeImpact | null = null

  // All keyed by `${kind}:${id}` so a loan and a credit card can never
  // collide even in the (extremely unlikely) event their generated ids
  // matched — every map/set below shares this convention.
  const exclusions = new Set<string>()
  const overpayments = new Map<string, number>()
  const savingsLumpSums = new Map<string, number>() // key: `${personId}:${entryId}`

  // Running balance per target as actions are applied in order, so a second
  // action targeting the same loan/card sees what the first one already
  // used — and so a single sale cascading through several targets in
  // priority order only spends each pound once, rather than every target
  // independently "seeing" its full original balance.
  const workingRemainingMap = new Map<string, number>()
  const lumpSumsApplied = new Map<string, number>()

  function targetKey(kind: ScenarioTargetKind, id: string): string {
    return `${kind}:${id}`
  }

  function workingRemaining(kind: ScenarioTargetKind, id: string): number {
    const key = targetKey(kind, id)
    if (!workingRemainingMap.has(key)) {
      if (kind === 'loan') {
        const loan = data.loans.find((l) => l.id === id)
        workingRemainingMap.set(key, loan ? summarizeLoan(loan).remaining : 0)
      } else {
        const card = data.creditCards.find((c) => c.id === id)
        workingRemainingMap.set(key, card ? card.currentBalance : 0)
      }
    }
    return workingRemainingMap.get(key)!
  }

  for (const action of scenario.actions) {
    if (action.type === 'sell_asset' || action.type === 'pay_off_loan') {
      const targets = resolveTargets(action)

      if (targets.length === 0) {
        // Unlinked sell_asset is just cash in hand. pay_off_loan with nothing
        // selected does nothing (the form requires a target to save it anyway).
        if (action.type === 'sell_asset') oneOffCashImpact += action.value
        continue
      }

      // Walk the targets in order, clearing each as far as this action's
      // value allows before moving to the next. A target with a manual
      // `amount` takes exactly that much (still capped to what's left in
      // the pool and what the target actually needs); one without an
      // amount auto-takes whatever's left in the pool. Whatever's left
      // after the last target is genuine one-off cash — not double-counted
      // against what any target already used.
      let pool = action.value
      for (const { kind, id, amount } of targets) {
        if (pool <= 0) break
        const remaining = workingRemaining(kind, id)
        const requested = amount != null ? amount : pool
        const applied = round2(Math.min(requested, pool, remaining))
        workingRemainingMap.set(targetKey(kind, id), round2(remaining - applied))
        const key = targetKey(kind, id)
        lumpSumsApplied.set(key, round2((lumpSumsApplied.get(key) ?? 0) + applied))
        pool = round2(pool - applied)
      }
      oneOffCashImpact += pool
    } else if (action.type === 'savings_lump_sum' && action.savingsEntryId) {
      const targetPersonId = action.personId || personId
      const key = `${targetPersonId}:${action.savingsEntryId}`
      savingsLumpSums.set(key, (savingsLumpSums.get(key) ?? 0) + action.value)
      // Putting money into savings is spending it, same as buying something —
      // it leaves whatever one-off cash this scenario generated.
      oneOffCashImpact -= action.value
    } else if (action.type === 'new_bill' || action.type === 'new_finance_agreement') {
      // Both are ongoing monthly costs — a simple new bill, or a finance
      // agreement's computed monthly payment. Not one-off, and only counts
      // toward this person's available cash based on its location/split,
      // same as a real bill would.
      const virtualBill: Bill = {
        id: `action:${action.id}`,
        name: action.name || (action.type === 'new_finance_agreement' ? 'New finance agreement' : 'New bill'),
        cost: action.value,
        dueDay: 1,
        location: action.location ?? 'personal',
        ownerId: action.ownerId ?? personId,
        payee: action.payee ?? personId,
        payeeSharePercent: action.payeeSharePercent ?? 100,
        category: 'Scenario',
        isStandingOrder: true,
      }
      monthlyImpact -= costForPerson(virtualBill, personId, data.people)
    } else if (action.type === 'exclude_loan') {
      const target = resolveTargets(action)[0]
      if (target) exclusions.add(targetKey(target.kind, target.id))
    } else if (action.type === 'loan_overpayment') {
      const target = resolveTargets(action)[0]
      if (target) {
        const key = targetKey(target.kind, target.id)
        overpayments.set(key, (overpayments.get(key) ?? 0) + action.value)
      }
    } else if (action.type === 'salary_change') {
      const targetPersonId = action.personId || personId
      const person = data.people.find((p) => p.id === targetPersonId)
      if (person) {
        const oldNetPerPeriod = calculateNetSalary(person.salary).netPerPeriod
        const newNetPerPeriod = calculateNetSalary({ ...person.salary, grossAnnual: action.value }).netPerPeriod
        const delta = newNetPerPeriod - oldNetPerPeriod
        salaryChangeImpact = { personId: targetPersonId, personName: person.name, oldNetMonthly: oldNetPerPeriod, newNetMonthly: newNetPerPeriod, delta }
        // Only affects the available-cash total for the person actually viewing this scenario
        if (targetPersonId === personId) monthlyImpact += delta
      }
    }
  }

  // --- Lump sum payoffs (now already correctly sequenced/clamped above) ---
  for (const [key, lumpSum] of lumpSumsApplied.entries()) {
    const [kind, id] = key.split(':') as [ScenarioTargetKind, string]

    if (kind === 'loan') {
      const loan = data.loans.find((l) => l.id === id)
      if (!loan) continue

      const original = summarizeLoan(loan)
      const newRemaining = round2(Math.max(0, original.remaining - lumpSum))
      const fullyPaidOff = newRemaining <= 0

      // If not fully cleared, spread the reduced balance over the same
      // remaining term — a genuinely reduced monthly payment, not a shorter one.
      const newMonthlyPayment = fullyPaidOff
        ? 0
        : original.monthsRemaining > 0
          ? round2(newRemaining / original.monthsRemaining)
          : loan.monthlyPayment

      const originalMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, currentLoanMonthlyCost(loan)), personId, data.people)
      const newMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, newMonthlyPayment), personId, data.people)
      monthlyImpact += originalMonthlyCostForPerson - newMonthlyCostForPerson

      loanImpacts.push({
        loanId: id,
        loanName: loan.name,
        targetKind: 'loan',
        kind: 'payoff',
        originalRemaining: original.remaining,
        newRemaining,
        lumpSumApplied: lumpSum,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: original.monthsRemaining,
        newMonthsRemaining: fullyPaidOff ? 0 : original.monthsRemaining,
        monthsSaved: fullyPaidOff ? original.monthsRemaining : 0,
        fullyPaidOff,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
      })
    } else {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue

      const newRemaining = round2(Math.max(0, card.currentBalance - lumpSum))
      const fullyPaidOff = newRemaining <= 0

      const originalMinimum = computeMinimumPaymentAmount(card)
      const newMinimum = computeMinimumPaymentAmount({ ...card, currentBalance: newRemaining })
      const originalMonthlyCostForPerson = cardMonthlyCostForPerson(card, originalMinimum, personId)
      const newMonthlyCostForPerson = fullyPaidOff ? 0 : cardMonthlyCostForPerson(card, newMinimum, personId)
      monthlyImpact += originalMonthlyCostForPerson - newMonthlyCostForPerson

      const originalPayoff = simulateCardPayoffMonths(card, 0)
      const newPayoff = fullyPaidOff ? { months: 0, totalInterestPaid: 0 } : simulateCardPayoffMonths({ ...card, currentBalance: newRemaining }, 0)

      loanImpacts.push({
        loanId: id,
        loanName: card.name,
        targetKind: 'credit_card',
        kind: 'payoff',
        originalRemaining: card.currentBalance,
        newRemaining,
        lumpSumApplied: lumpSum,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: originalPayoff.months,
        newMonthsRemaining: newPayoff.months,
        monthsSaved: Math.max(0, originalPayoff.months - newPayoff.months),
        fullyPaidOff,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
      })
    }
  }

  // --- Exclusions: "what if this loan/card just didn't count" ---
  for (const key of exclusions) {
    const [kind, id] = key.split(':') as [ScenarioTargetKind, string]

    if (kind === 'loan') {
      const loan = data.loans.find((l) => l.id === id)
      if (!loan) continue

      const original = summarizeLoan(loan)
      const originalMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, currentLoanMonthlyCost(loan)), personId, data.people)
      monthlyImpact += originalMonthlyCostForPerson

      loanImpacts.push({
        loanId: id,
        loanName: loan.name,
        targetKind: 'loan',
        kind: 'exclude',
        originalRemaining: original.remaining,
        newRemaining: original.remaining, // unchanged — it's excluded from your budget, not paid off
        lumpSumApplied: 0,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: original.monthsRemaining,
        newMonthsRemaining: original.monthsRemaining,
        monthsSaved: 0,
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson: 0,
      })
    } else {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue

      const originalMinimum = computeMinimumPaymentAmount(card)
      const originalMonthlyCostForPerson = cardMonthlyCostForPerson(card, originalMinimum, personId)
      monthlyImpact += originalMonthlyCostForPerson
      const payoff = simulateCardPayoffMonths(card, 0)

      loanImpacts.push({
        loanId: id,
        loanName: card.name,
        targetKind: 'credit_card',
        kind: 'exclude',
        originalRemaining: card.currentBalance,
        newRemaining: card.currentBalance,
        lumpSumApplied: 0,
        overpaymentPerMonth: 0,
        originalMonthsRemaining: payoff.months,
        newMonthsRemaining: payoff.months,
        monthsSaved: 0,
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson: 0,
      })
    }
  }

  // --- Regular overpayments: an extra amount every month, shortening the term ---
  for (const [key, extraPerMonth] of overpayments.entries()) {
    const [kind, id] = key.split(':') as [ScenarioTargetKind, string]
    if (extraPerMonth <= 0) continue

    if (kind === 'loan') {
      const loan = data.loans.find((l) => l.id === id)
      if (!loan) continue

      const original = summarizeLoan(loan)
      const newMonthlyPayment = loan.monthlyPayment + extraPerMonth
      const newMonthsRemaining = newMonthlyPayment > 0 ? Math.ceil(original.remaining / newMonthlyPayment) : original.monthsRemaining

      const originalMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, currentLoanMonthlyCost(loan)), personId, data.people)
      const newMonthlyCostForPerson = costForPerson(virtualLoanBill(loan, Math.min(newMonthlyPayment, original.remaining)), personId, data.people)
      // Overpaying costs more per month now (a negative to available cash)
      monthlyImpact += originalMonthlyCostForPerson - newMonthlyCostForPerson

      loanImpacts.push({
        loanId: id,
        loanName: loan.name,
        targetKind: 'loan',
        kind: 'overpayment',
        originalRemaining: original.remaining,
        newRemaining: original.remaining, // principal isn't reduced instantly, just paid down faster over time
        lumpSumApplied: 0,
        overpaymentPerMonth: extraPerMonth,
        originalMonthsRemaining: original.monthsRemaining,
        newMonthsRemaining,
        monthsSaved: Math.max(0, original.monthsRemaining - newMonthsRemaining),
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
      })
    } else {
      const card = data.creditCards.find((c) => c.id === id)
      if (!card) continue

      const originalMinimum = computeMinimumPaymentAmount(card)
      const originalMonthlyCostForPerson = cardMonthlyCostForPerson(card, originalMinimum, personId)
      // Actual new monthly outlay — minimum plus the overpayment, capped to
      // what's actually owed (mirrors the loan case's own capping).
      const newMonthlyCostForPerson = cardMonthlyCostForPerson(card, Math.min(originalMinimum + extraPerMonth, card.currentBalance), personId)
      monthlyImpact += originalMonthlyCostForPerson - newMonthlyCostForPerson

      const originalPayoff = simulateCardPayoffMonths(card, 0)
      const newPayoff = simulateCardPayoffMonths(card, extraPerMonth)

      loanImpacts.push({
        loanId: id,
        loanName: card.name,
        targetKind: 'credit_card',
        kind: 'overpayment',
        originalRemaining: card.currentBalance,
        newRemaining: card.currentBalance,
        lumpSumApplied: 0,
        overpaymentPerMonth: extraPerMonth,
        originalMonthsRemaining: originalPayoff.months,
        newMonthsRemaining: newPayoff.months,
        monthsSaved: Math.max(0, originalPayoff.months - newPayoff.months),
        fullyPaidOff: false,
        originalMonthlyCostForPerson,
        newMonthlyCostForPerson,
      })
    }
  }

  // --- Savings lump sums: how much sooner a goal is hit ---
  const savingsImpacts: SavingsLumpSumImpact[] = []
  for (const [key, lumpSum] of savingsLumpSums.entries()) {
    const [targetPersonId, entryId] = key.split(':')
    const person = data.people.find((p) => p.id === targetPersonId)
    const entry = person?.savingsEntries.find((e) => e.id === entryId)
    if (!person || !entry) continue

    const originalRemaining = Math.max(0, (entry.targetAmount ?? 0) - (entry.currentAmount ?? 0))
    const newRemaining = round2(Math.max(0, originalRemaining - lumpSum))
    const hasTargetDate = Boolean(entry.targetDate)

    let monthsSaved = 0
    if (hasTargetDate) {
      // Assume the same monthly contribution the goal was already relying on
      // to hit its date — the lump sum just means fewer months are needed
      // at that same rate, not a promise to save any faster afterward.
      const monthlyRate = monthlyAmountForEntry(entry)
      const originalMonths = monthsUntil(entry.targetDate!)
      const newMonths = monthlyRate > 0 ? Math.ceil(newRemaining / monthlyRate) : 0
      monthsSaved = Math.max(0, originalMonths - newMonths)
    }

    savingsImpacts.push({
      personName: person.name,
      goalName: entry.name || 'Unnamed goal',
      lumpSumApplied: lumpSum,
      originalRemaining,
      newRemaining,
      monthsSaved,
      hasTargetDate,
    })
  }

  return {
    oneOffCashImpact: round2(oneOffCashImpact),
    monthlyAvailableBefore,
    monthlyAvailableAfter: round2(monthlyAvailableBefore + monthlyImpact),
    monthlyImpact: round2(monthlyImpact),
    loanImpacts,
    salaryChangeImpact,
    savingsImpacts,
  }
}

/** A loan's monthly payment represented as a Bill, so it can reuse the same person-split logic. */
function virtualLoanBill(loan: Loan, cost: number): Bill {
  return {
    id: `loan:${loan.id}`,
    name: loan.name,
    cost,
    dueDay: 1,
    location: loan.location,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    category: 'Loan',
    ownerId: loan.ownerId,
    isStandingOrder: true,
  }
}

/**
 * Same scenario, but the household's combined view rather than one person's:
 * every loan/card/bill/finance-agreement counted at its full value rather
 * than anyone's split share, and a salary change counts regardless of
 * whose it is.
 *
 * Implemented by running the normal per-person calculation once for every
 * person and summing their monthly deltas — the split percentages on every
 * bill and loan always add up to 100% across the household (and a credit
 * card is always 100% its owner's), so summing each person's share back
 * together reconstructs the true, unsplit total. The one-off cash figure
 * and each target's own balance/term fields are identical no matter who
 * they're calculated "for", so those are taken once rather than summed
 * (summing them would multiply by however many people there are).
 */
export function calculateHouseholdScenarioImpact(scenario: Scenario, data: AppData, monthlyAvailableBefore: number): ScenarioImpact {
  const perPerson = data.people.map((p) => calculateScenarioImpact(scenario, data, p.id, 0))

  const oneOffCashImpact = perPerson[0]?.oneOffCashImpact ?? 0
  const monthlyImpact = round2(perPerson.reduce((sum, r) => sum + r.monthlyImpact, 0))

  const loanImpactsByKey = new Map<string, LoanImpact>()
  for (const result of perPerson) {
    for (const li of result.loanImpacts) {
      const key = `${li.targetKind}:${li.loanId}:${li.kind}`
      const existing = loanImpactsByKey.get(key)
      if (existing) {
        existing.originalMonthlyCostForPerson = round2(existing.originalMonthlyCostForPerson + li.originalMonthlyCostForPerson)
        existing.newMonthlyCostForPerson = round2(existing.newMonthlyCostForPerson + li.newMonthlyCostForPerson)
      } else {
        loanImpactsByKey.set(key, { ...li })
      }
    }
  }

  return {
    oneOffCashImpact,
    monthlyAvailableBefore,
    monthlyAvailableAfter: round2(monthlyAvailableBefore + monthlyImpact),
    monthlyImpact,
    loanImpacts: Array.from(loanImpactsByKey.values()),
    salaryChangeImpact: perPerson.find((r) => r.salaryChangeImpact)?.salaryChangeImpact ?? null,
    savingsImpacts: perPerson[0]?.savingsImpacts ?? [],
  }
}

/**
 * Combines several scenarios into one, so their combined effect can be run
 * through calculateScenarioImpact in a single pass. This matters for
 * correctness, not just convenience: if two scenarios both target the same
 * loan/card, their lump sums/overpayments need to be summed together
 * against its real remaining balance, not evaluated independently against
 * the same starting point twice.
 */
export function mergeScenarios(scenarios: Scenario[]): Scenario {
  return {
    id: 'combined',
    name: 'Combined',
    includeInCumulative: false,
    actions: scenarios.flatMap((s) => s.actions),
  }
}

/**
 * Reads an action's loan/credit-card targets, supporting older saved-
 * scenario field shapes from before credit-card targets (or even
 * per-target amounts) existed. Preference order: the current `targets`
 * field; then the old loan-only `loanAllocations`; then an even older
 * `linkedLoanIds` array some saved scenarios may still have; then a
 * single-target `linkedTargetKind`/`linkedTargetId` pair (today's shape
 * for exclude_loan/loan_overpayment); then the oldest single-target shape,
 * `linkedLoanId`. Everything found via a loan-only legacy field is
 * reported as kind: 'loan', since credit cards didn't exist as a target
 * when those fields were the only ones written.
 */
export function resolveTargets(action: Scenario['actions'][number]): { kind: ScenarioTargetKind; id: string; amount?: number }[] {
  if (action.targets?.length) return action.targets
  if (action.loanAllocations?.length) return action.loanAllocations.map((a) => ({ kind: 'loan' as const, id: a.loanId, amount: a.amount }))
  const legacy = action as unknown as { linkedLoanIds?: string[] }
  if (legacy.linkedLoanIds?.length) return legacy.linkedLoanIds.map((loanId) => ({ kind: 'loan' as const, id: loanId }))
  if (action.linkedTargetKind && action.linkedTargetId) return [{ kind: action.linkedTargetKind, id: action.linkedTargetId }]
  if (action.linkedLoanId) return [{ kind: 'loan' as const, id: action.linkedLoanId }]
  return []
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
