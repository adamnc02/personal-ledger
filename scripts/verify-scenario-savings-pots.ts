// PROMPT-07 Part 1: What-if savings-pot actions (savings_pot_lump_sum,
// savings_pot_withdrawal, savings_pot_recurring_deposit_change), rebuilt
// against real savings pots after Q6's legacy savings-goal removal took
// out the old savings_lump_sum action (DECISIONS-2026-09-15.md Q6).
//
// Redesigned 2026-09-17 after Adam's UAT: ONE impact per pot, every action
// on that pot applied together, "now" vs "after".
//
// Section 1: synthetic pots, the maths in isolation.
// Section 2: Adam's real backup. Proves the follows-payday deposit is
//   counted and resolved to its paid date (Batch 21, APP-KNOWLEDGE.md
//   §1.13a), and that a lump sum actually raises the projected balance
//   (it didn't: projectedBalanceAt ignores `currentBalance`).
// Section 3: mum's real backup (no savings pots): no pot impacts, no errors.
//
// The engine uses the real `new Date()`, so section 1 fixtures use target
// dates far in the future, and section 2 uses relational checks only.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { calculateScenarioImpact, calculateHouseholdScenarioImpact } from '../src/lib/scenarios'
import { newSavingsPot } from '../src/lib/savingsPotLedger'
import { todayIso } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Person, RecurringTemplate, SavingsPot } from '../src/types/ledger'
import type { AppData, Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}

type Action = Scenario['actions'][number]
function scenario(...actions: Omit<Action, 'id' | 'label'>[]): Scenario {
  return { id: 'sc', name: 'Test', includeInCumulative: true, actions: actions.map((a, i) => ({ id: `a${i}`, label: '', ...a })) }
}
const noInterest = { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' } as const

console.log('1. Synthetic pots')
{
  const me: Person = {
    id: 'me',
    name: 'Me',
    color: '#ff5b4c',
    salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
    salaryOverrides: [],
  }
  const pot = (id: string, overrides: Partial<Parameters<typeof newSavingsPot>[0]>): SavingsPot => ({
    ...newSavingsPot({ personId: 'me', name: id, openingBalance: 5000, openingDate: '2026-01-01', interestMethod: noInterest, color: '#8b5cf6', ...overrides }),
    id,
  })
  const targetPot = pot('pot-target', { targetAmount: 50000, targetDate: '2035-01-01' })
  const amountOnlyPot = pot('pot-amount-only', { targetAmount: 50000 })
  const noTargetPot = pot('pot-no-target', { openingBalance: 2000 })
  const reachedPot = pot('pot-reached', { openingBalance: 3000, targetAmount: 2500 })
  const weeklyPot = pot('pot-weekly', { targetAmount: 50000 })

  const transfer = (id: string, potId: string, amount: number, frequency: RecurringTemplate['frequency']): RecurringTemplate => ({
    id,
    name: id,
    amount,
    categoryId: 'category-savings',
    paymentMethod: 'bank_transfer',
    frequency,
    anchorDate: '2026-01-05',
    location: 'personal',
    ownerId: 'me',
    payee: '',
    payeeSharePercent: 100,
    kind: 'transfer',
    transferFrom: { type: 'personal' },
    transferTo: { type: 'savings', savingsPotId: potId },
    active: true,
  })
  const payCycle: PayCycleConfig = { personId: 'me', openingBalance: 0, openingBalanceDate: '2026-01-01', paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1 }

  const ledgerData: AppDataV2 = {
    people: [me],
    categories: [],
    recurringTemplates: [transfer('tpl-target', 'pot-target', 500, 'monthly'), transfer('tpl-amount', 'pot-amount-only', 500, 'monthly'), transfer('tpl-weekly', 'pot-weekly', 100, 'weekly')],
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [payCycle],
    savingsPots: [targetPot, amountOnlyPot, noTargetPot, reachedPot, weeklyPot],
    scenarios: [],
    primaryPersonId: 'me',
  }
  const data = buildLegacyAppData(ledgerData)
  checkTrue('All five pots pass through the bridge', data.savingsPots.length === 5)

  // ---- "Now" section ----
  const nowOnly = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1, savingsPotId: 'pot-target' }), data, 'me', 0).savingsPotImpacts[0]
  check('Now: balance', nowOnly.balanceNow, 5000)
  check('Now: target amount', nowOnly.targetAmount, 50000)
  check('Now: target date', nowOnly.targetDate, '2035-01-01')
  checkTrue('Now: on-track-for date is set', Boolean(nowOnly.currentReachDate), nowOnly.currentReachDate)
  checkTrue('Now: months behind target is a number when both dates exist', typeof nowOnly.monthsBehindTarget === 'number', nowOnly.monthsBehindTarget)

  // ---- Lump sum ----
  const lump = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 2000, savingsPotId: 'pot-target' }), data, 'me', 0)
  const lumpPot = lump.savingsPotImpacts[0]
  check('Lump sum: one impact', lump.savingsPotImpacts.length, 1)
  check('Lump sum: balance after', lumpPot.balanceAfter, 7000)
  check('Lump sum: total', lumpPot.lumpSumTotal, 2000)
  check('Lump sum: one-off cash impact', lump.oneOffCashImpact, -2000)
  check('Lump sum: no monthly impact', lump.monthlyImpact, 0)
  check('Lump sum: no recurring change shown', lumpPot.newRecurringMonthlyAmount, null)
  checkTrue('Lump sum: reaches target sooner', lumpPot.monthsSaved > 0, { from: lumpPot.currentReachDate, to: lumpPot.newReachDate })
  // Regression (Adam's 2026-09-17 screenshot): the lump sum used to leave the projection unchanged.
  check('Lump sum: balance on the target date rises by the lump sum (no interest)', (lumpPot.balanceOnTargetDateAfter ?? 0) - (lumpPot.balanceOnTargetDateBefore ?? 0), 2000)

  // ---- Withdrawal, capped against the running balance ----
  const withdraw = calculateScenarioImpact(scenario({ type: 'savings_pot_withdrawal', value: 1500, savingsPotId: 'pot-target' }), data, 'me', 0).savingsPotImpacts[0]
  check('Withdrawal: balance after', withdraw.balanceAfter, 3500)
  checkTrue('Withdrawal: reaches target later', withdraw.monthsSaved < 0, withdraw.monthsSaved)
  check('Withdrawal: balance on the target date falls by the withdrawal', (withdraw.balanceOnTargetDateAfter ?? 0) - (withdraw.balanceOnTargetDateBefore ?? 0), -1500)

  const capped = calculateScenarioImpact(
    scenario({ type: 'savings_pot_lump_sum', value: 1000, savingsPotId: 'pot-target' }, { type: 'savings_pot_withdrawal', value: 999999, savingsPotId: 'pot-target' }),
    data,
    'me',
    0,
  )
  check('Capped withdrawal: takes lump sum + balance, no more', capped.savingsPotImpacts[0].withdrawalTotal, 6000)
  check('Capped withdrawal: balance after is £0', capped.savingsPotImpacts[0].balanceAfter, 0)
  check('Capped withdrawal: one-off cash is -£1,000 in, +£6,000 out', capped.oneOffCashImpact, 5000)

  // ---- Recurring deposit change ----
  const bigger = calculateScenarioImpact(scenario({ type: 'savings_pot_recurring_deposit_change', value: 800, savingsPotId: 'pot-target' }), data, 'me', 1000)
  const biggerPot = bigger.savingsPotImpacts[0]
  check('Recurring: old monthly amount', biggerPot.oldRecurringMonthlyAmount, 500)
  check('Recurring: new monthly amount', biggerPot.newRecurringMonthlyAmount, 800)
  check('Recurring: costs £300/mo of available cash', bigger.monthlyImpact, -300)
  check('Recurring: balance unchanged today', biggerPot.balanceAfter, biggerPot.balanceNow)
  checkTrue('Recurring: reaches target sooner', biggerPot.monthsSaved > 0, biggerPot.monthsSaved)
  checkTrue('Recurring: balance on the target date rises', (biggerPot.balanceOnTargetDateAfter ?? 0) > (biggerPot.balanceOnTargetDateBefore ?? 0))

  const twoChanges = calculateScenarioImpact(
    scenario({ type: 'savings_pot_recurring_deposit_change', value: 800, savingsPotId: 'pot-target' }, { type: 'savings_pot_recurring_deposit_change', value: 600, savingsPotId: 'pot-target' }),
    data,
    'me',
    0,
  )
  check('Two recurring changes to one pot: one impact', twoChanges.savingsPotImpacts.length, 1)
  check('Two recurring changes: the later one wins', twoChanges.savingsPotImpacts[0].newRecurringMonthlyAmount, 600)
  check('Two recurring changes: monthly impact counted once', twoChanges.monthlyImpact, -100)

  const weekly = calculateScenarioImpact(scenario({ type: 'savings_pot_recurring_deposit_change', value: 866.67, savingsPotId: 'pot-weekly' }), data, 'me', 0).savingsPotImpacts[0]
  check('Weekly template: old amount shown as its monthly equivalent (£100 × 52/12)', weekly.oldRecurringMonthlyAmount, 433.33)
  checkTrue('Weekly template: doubling the monthly figure brings the target forward', weekly.monthsSaved > 0, weekly.monthsSaved)

  // ---- Lump sum + recurring change together (Adam's screenshot) ----
  const combined = calculateScenarioImpact(
    scenario({ type: 'savings_pot_lump_sum', value: 2000, savingsPotId: 'pot-target' }, { type: 'savings_pot_recurring_deposit_change', value: 800, savingsPotId: 'pot-target' }),
    data,
    'me',
    1000,
  )
  const combinedPot = combined.savingsPotImpacts[0]
  check('Combined: ONE card for the pot, not one per action', combined.savingsPotImpacts.length, 1)
  checkTrue('Combined: carries both the lump sum and the new deposit', combinedPot.lumpSumTotal === 2000 && combinedPot.newRecurringMonthlyAmount === 800)
  checkTrue('Combined: sooner than either change alone', combinedPot.monthsSaved > Math.max(lumpPot.monthsSaved, biggerPot.monthsSaved), {
    combined: combinedPot.monthsSaved,
    lump: lumpPot.monthsSaved,
    recurring: biggerPot.monthsSaved,
  })
  checkTrue(
    'Combined: balance on the target date beats either change alone',
    (combinedPot.balanceOnTargetDateAfter ?? 0) > Math.max(lumpPot.balanceOnTargetDateAfter ?? 0, biggerPot.balanceOnTargetDateAfter ?? 0),
  )
  check('Combined: monthly impact', combined.monthlyImpact, -300)
  check('Combined: one-off impact', combined.oneOffCashImpact, -2000)

  // ---- Pots without a target date / without a target ----
  const amountOnly = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 2000, savingsPotId: 'pot-amount-only' }), data, 'me', 0).savingsPotImpacts[0]
  checkTrue('Target amount, no date: still shows reach dates', Boolean(amountOnly.currentReachDate && amountOnly.newReachDate))
  check('Target amount, no date: no months-behind figure', amountOnly.monthsBehindTarget, null)
  check('Target amount, no date: no balance projection', amountOnly.balanceOnTargetDateAfter, null)

  const noTarget = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 500, savingsPotId: 'pot-no-target' }), data, 'me', 0).savingsPotImpacts[0]
  check('No target: target amount null', noTarget.targetAmount, null)
  check('No target: no reach dates', [noTarget.currentReachDate, noTarget.newReachDate], [null, null])
  check('No target: no time saved', noTarget.monthsSaved, 0)
  check('No target: no balance projection', [noTarget.balanceOnTargetDateBefore, noTarget.balanceOnTargetDateAfter], [null, null])
  check('No target: balance after still shown', noTarget.balanceAfter, 2500)

  const reached = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 100, savingsPotId: 'pot-reached' }), data, 'me', 0).savingsPotImpacts[0]
  check('Target already reached: flagged', reached.targetReached, true)
  check('Target already reached: no reach dates', [reached.currentReachDate, reached.newReachDate], [null, null])

  // ---- Past target date: no projection onto a date that has gone ----
  const pastData: AppData = { ...data, savingsPots: data.savingsPots.map((p) => (p.id === 'pot-target' ? { ...p, targetDate: '2020-01-01' } : p)) }
  const past = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 100, savingsPotId: 'pot-target' }), pastData, 'me', 0).savingsPotImpacts[0]
  check('Target date in the past: no balance projection', past.balanceOnTargetDateAfter, null)
  checkTrue('Target date in the past: shown as late', (past.monthsBehindTarget ?? 0) > 0, past.monthsBehindTarget)

  // ---- Viewer scoping and household ----
  const mum: Person = { ...me, id: 'mum', name: 'Mum', salaryHistory: [{ ...me.salaryHistory[0], id: 's2', personId: 'mum' }] }
  const householdData = buildLegacyAppData({ ...ledgerData, people: [me, mum] })
  const recurringScenario = scenario({ type: 'savings_pot_recurring_deposit_change', value: 800, savingsPotId: 'pot-target' })
  check("Recurring change on my pot: no monthly impact in mum's view", calculateScenarioImpact(recurringScenario, householdData, 'mum', 0).monthlyImpact, 0)
  const household = calculateHouseholdScenarioImpact(recurringScenario, householdData, 0)
  check('Household: monthly impact counted once', household.monthlyImpact, -300)
  check('Household: one card', household.savingsPotImpacts.length, 1)

  // ---- Missing pot ----
  const missing = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 100 }), data, 'me', 0)
  check('No pot chosen: no impact, no throw', missing.savingsPotImpacts.length, 0)
  check('No pot chosen: no one-off impact either', missing.oneOffCashImpact, 0)
}

console.log("\n2. Adam's real backup")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json', 'utf8'))
  const data = buildLegacyAppData(migrateLedgerData(raw.data ?? raw))
  const pot = data.savingsPots.find((p) => p.name === 'Savings')!
  checkTrue("'Savings' pot exposed with its real target (£10,000 by 31 Mar 2027)", pot?.targetAmount === 10000 && pot?.targetDate === '2027-03-31')

  const lump = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1000, savingsPotId: pot.id }), data, data.primaryPersonId, 0).savingsPotImpacts[0]
  checkTrue('Lump sum £1,000: reaches the target no later', lump.monthsSaved >= 0 && Boolean(lump.newReachDate), { from: lump.currentReachDate, to: lump.newReachDate })
  if (pot.targetDate! > todayIso()) {
    const gain = (lump.balanceOnTargetDateAfter ?? 0) - (lump.balanceOnTargetDateBefore ?? 0)
    checkTrue('Lump sum £1,000: balance on 31 Mar 2027 rises by £1,000 plus a little interest (was £0 before the fix)', gain >= 1000 && gain < 1100, gain)
  } else {
    console.log('  (skipped the target-date balance check: 31 Mar 2027 has passed)')
  }

  const combined = calculateScenarioImpact(
    scenario({ type: 'savings_pot_lump_sum', value: 1000, savingsPotId: pot.id }, { type: 'savings_pot_recurring_deposit_change', value: 1500, savingsPotId: pot.id }),
    data,
    data.primaryPersonId,
    0,
  )
  check("Adam's screenshot scenario: one card, not two", combined.savingsPotImpacts.length, 1)
  check("Adam's screenshot scenario: old deposit read off 'Savings Deposit'", combined.savingsPotImpacts[0].oldRecurringMonthlyAmount, 1000)
  check("Adam's screenshot scenario: -£500/mo", combined.monthlyImpact, -500)

  // 🚨 Batch 21: the £1,000/mo follows-payday deposit must be counted
  // (strip the templates and the pot never reaches its target) and dated
  // on payday, not its 12th-of-the-month slot (strip the pay cycle and the
  // reach date moves).
  const noTemplates: AppData = { ...data, recurringTemplates: [] }
  const noPayCycle: AppData = { ...data, payCycles: [] }
  const reachReal = lump.currentReachDate
  const reachNoTemplates = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1000, savingsPotId: pot.id }), noTemplates, data.primaryPersonId, 0).savingsPotImpacts[0].currentReachDate
  const reachNoPayCycle = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 1000, savingsPotId: pot.id }), noPayCycle, data.primaryPersonId, 0).savingsPotImpacts[0].currentReachDate
  checkTrue('Without the recurring templates, the deposit vanishes: target not reached for years', reachNoTemplates === null || (reachReal !== null && reachNoTemplates > reachReal), { reachReal, reachNoTemplates })
  checkTrue('Without the pay cycle, the deposit lands on the wrong day: the reach date changes', reachReal !== reachNoPayCycle, { reachReal, reachNoPayCycle })
}

console.log("\n3. Mum's real backup (no savings pots)")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json', 'utf8'))
  const data = buildLegacyAppData(migrateLedgerData(raw.data ?? raw))
  check('No savings pots at all', data.savingsPots.length, 0)
  let threw = false
  let impact: ReturnType<typeof calculateScenarioImpact> | undefined
  try {
    impact = calculateScenarioImpact(scenario({ type: 'savings_pot_lump_sum', value: 100, savingsPotId: 'nonexistent' }), data, data.primaryPersonId, 0)
  } catch {
    threw = true
  }
  checkTrue('A pot action pointing at a missing pot does not throw', !threw)
  check('...and produces no pot impacts', impact?.savingsPotImpacts.length, 0)
}

console.log(failures === 0 ? '\nAll savings-pot scenario checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
