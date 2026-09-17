// PROMPT-07 Part 1 — What-if savings-pot actions (savings_pot_lump_sum,
// savings_pot_withdrawal, savings_pot_recurring_deposit_change), rebuilt
// against real savings pots after Q6's legacy savings-goal removal took
// out the old savings_lump_sum action (DECISIONS-2026-09-15.md Q6).
//
// Section 1: synthetic pots — the maths in isolation.
// Section 2: Adam's real backup, as of a fixed date — proves the
//   follows-payday deposit is actually counted (Batch 21 — a projection
//   built without the real recurring templates AND the pay cycle silently
//   drops it, APP-KNOWLEDGE.md §1.13a). Run under both TZ=Europe/London
//   and TZ=UTC.
// Section 3: mum's real backup (no savings pots at all) — must produce no
//   pot actions and no errors, not an empty-picker crash.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { calculateScenarioImpact } from '../src/lib/scenarios'
import { newSavingsPot } from '../src/lib/savingsPotLedger'
import type { AppDataV2, PayCycleConfig, Person, RecurringTemplate, SavingsPot } from '../src/types/ledger'
import type { Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}

console.log('1. Synthetic pots — the maths in isolation')
{
  const me: Person = {
    id: 'me',
    name: 'Me',
    color: '#ff5b4c',
    salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
    salaryOverrides: [],
  }

  const targetPot: SavingsPot = {
    ...newSavingsPot({
      personId: 'me',
      name: 'House deposit',
      openingBalance: 5000,
      openingDate: '2026-01-01',
      interestMethod: { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' },
      targetAmount: 10000,
      targetDate: '2027-01-01',
      color: '#8b5cf6',
    }),
    id: 'pot-target',
  }
  const noTargetPot: SavingsPot = {
    ...newSavingsPot({
      personId: 'me',
      name: 'Rainy day',
      openingBalance: 2000,
      openingDate: '2026-01-01',
      interestMethod: { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' },
      color: '#22c55e',
    }),
    id: 'pot-no-target',
  }

  // £500/month into targetPot, follows no special dating (plain monthly).
  const depositTemplate: RecurringTemplate = {
    id: 'tpl-deposit',
    name: 'House deposit transfer',
    amount: 500,
    categoryId: 'category-savings',
    paymentMethod: 'bank_transfer',
    frequency: 'monthly',
    anchorDate: '2026-01-05',
    location: 'personal',
    ownerId: 'me',
    payee: '',
    payeeSharePercent: 100,
    kind: 'transfer',
    transferFrom: { type: 'personal' },
    transferTo: { type: 'savings', savingsPotId: 'pot-target' },
    active: true,
  }

  const payCycle: PayCycleConfig = {
    personId: 'me',
    openingBalance: 0,
    openingBalanceDate: '2026-01-01',
    paydayDayOfMonth: 28,
    paydayAdjustForNonWorkingDay: true,
    cycleStartDayOfMonth: 1,
  }

  const ledgerData: AppDataV2 = {
    people: [me],
    categories: [],
    recurringTemplates: [depositTemplate],
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [payCycle],
    savingsPots: [targetPot, noTargetPot],
    scenarios: [],
    primaryPersonId: 'me',
  }

  const asOf = new Date(2026, 5, 1) // 1 June 2026 — no time-of-day flakiness
  const data = buildLegacyAppData(ledgerData, asOf)
  checkTrue('Both pots pass through the bridge', data.savingsPots.length === 2, data.savingsPots.map((p) => p.name))

  // ---- Lump sum ----
  const lumpSumScenario: Scenario = {
    id: 'sc-lump',
    name: 'Lump sum',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_lump_sum', label: '', value: 2000, savingsPotId: 'pot-target' }],
  }
  const lumpImpact = calculateScenarioImpact(lumpSumScenario, data, 'me', 0)
  const lumpPotImpact = lumpImpact.savingsPotImpacts[0]
  checkTrue('One savings-pot impact produced', lumpImpact.savingsPotImpacts.length === 1)
  check('Balance now is the opening balance (nothing deposited yet by 1 Jun in this fixture)', lumpPotImpact?.balanceNow, 5000)
  check('Balance after = balance now + lump sum', lumpPotImpact?.balanceAfter, 7000)
  check('One-off cash impact is the lump sum, negative (money leaving available cash)', lumpImpact.oneOffCashImpact, -2000)
  checkTrue('Lump sum brings the target date forward (positive months saved)', (lumpPotImpact?.monthsSaved ?? 0) > 0, lumpPotImpact?.monthsSaved)
  checkTrue('A pot WITH a target produces a new target date', lumpPotImpact?.newTargetDate !== null, lumpPotImpact?.newTargetDate)
  check('No monthly impact from a one-off lump sum', lumpImpact.monthlyImpact, 0)

  // ---- Withdrawal ----
  const withdrawalScenario: Scenario = {
    id: 'sc-withdraw',
    name: 'Withdrawal',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_withdrawal', label: '', value: 1500, savingsPotId: 'pot-target' }],
  }
  const withdrawImpact = calculateScenarioImpact(withdrawalScenario, data, 'me', 0)
  const withdrawPotImpact = withdrawImpact.savingsPotImpacts[0]
  check('Balance after = balance now − withdrawal', withdrawPotImpact?.balanceAfter, 3500)
  check('One-off cash impact is the withdrawal, positive (money freed up)', withdrawImpact.oneOffCashImpact, 1500)
  checkTrue('A withdrawal pushes the target date back (negative months saved) or leaves it unchanged', (withdrawPotImpact?.monthsSaved ?? 0) <= 0, withdrawPotImpact?.monthsSaved)

  // ---- Withdrawal capped to balance ----
  const overWithdrawScenario: Scenario = {
    id: 'sc-over',
    name: 'Over-withdraw',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_withdrawal', label: '', value: 999999, savingsPotId: 'pot-target' }],
  }
  const overWithdrawImpact = calculateScenarioImpact(overWithdrawScenario, data, 'me', 0)
  check("A withdrawal can't take the balance below zero", overWithdrawImpact.savingsPotImpacts[0]?.balanceAfter, 0)
  check('One-off cash impact is capped to what the pot actually held', overWithdrawImpact.oneOffCashImpact, 5000)

  // ---- No target → no time saved, no target dates ----
  const noTargetScenario: Scenario = {
    id: 'sc-no-target',
    name: 'Lump sum, no target',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_lump_sum', label: '', value: 500, savingsPotId: 'pot-no-target' }],
  }
  const noTargetImpact = calculateScenarioImpact(noTargetScenario, data, 'me', 0)
  const noTargetPotImpact = noTargetImpact.savingsPotImpacts[0]
  check('A pot with no targetAmount shows no time saved', noTargetPotImpact?.monthsSaved, 0)
  check('...and no original target date', noTargetPotImpact?.originalTargetDate, null)
  check('...and no new target date', noTargetPotImpact?.newTargetDate, null)

  // ---- Recurring deposit change ----
  const increaseScenario: Scenario = {
    id: 'sc-increase',
    name: 'Bigger deposit',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_recurring_deposit_change', label: '', value: 800, savingsPotId: 'pot-target' }],
  }
  const increaseImpact = calculateScenarioImpact(increaseScenario, data, 'me', 1000)
  const increasePotImpact = increaseImpact.savingsPotImpacts[0]
  check('Old recurring amount read off the real transfer template', increasePotImpact?.oldRecurringMonthlyAmount, 500)
  check('New recurring amount is the hypothetical value', increasePotImpact?.newRecurringMonthlyAmount, 800)
  check('A bigger monthly deposit costs £300/mo of available cash', increaseImpact.monthlyImpact, -300)
  check('Available-after reflects the £300/mo cost', increaseImpact.monthlyAvailableAfter, 700)
  checkTrue('A bigger recurring deposit brings the target date forward', (increasePotImpact?.monthsSaved ?? 0) > 0, increasePotImpact?.monthsSaved)
  checkTrue("Balance doesn't change immediately — nothing has landed today", increasePotImpact?.balanceAfter === increasePotImpact?.balanceNow)

  // A recurring-deposit-change action against a pot with NO existing
  // transfer template — models "add a new recurring deposit from scratch".
  const newDepositScenario: Scenario = {
    id: 'sc-new-deposit',
    name: 'New recurring deposit',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_recurring_deposit_change', label: '', value: 200, savingsPotId: 'pot-no-target' }],
  }
  const newDepositImpact = calculateScenarioImpact(newDepositScenario, data, 'me', 0)
  const newDepositPotImpact = newDepositImpact.savingsPotImpacts[0]
  check('No existing template → old recurring amount is £0', newDepositPotImpact?.oldRecurringMonthlyAmount, 0)
  check('A brand-new £200/mo deposit projects a higher balance than doing nothing', newDepositPotImpact?.projectedBalanceAfter && newDepositPotImpact.projectedBalanceAfter > newDepositPotImpact.projectedBalanceBefore, true)

  // ---- Household view includes both people's pots ----
  const mum: Person = { ...me, id: 'mum', name: 'Mum', salaryHistory: [{ ...me.salaryHistory[0], id: 's2', personId: 'mum' }] }
  const mumPot: SavingsPot = {
    ...newSavingsPot({ personId: 'mum', name: "Mum's pot", openingBalance: 1000, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' }, color: '#f59e0b' }),
    id: 'pot-mum',
  }
  const householdLedgerData: AppDataV2 = { ...ledgerData, people: [me, mum], savingsPots: [...ledgerData.savingsPots, mumPot] }
  const householdData = buildLegacyAppData(householdLedgerData, asOf)
  checkTrue("Household view exposes both people's pots", householdData.savingsPots.some((p) => p.personId === 'mum') && householdData.savingsPots.some((p) => p.personId === 'me'))

  // ---- No pot selected → no crash, no impact ----
  const unselectedScenario: Scenario = {
    id: 'sc-unselected',
    name: 'No pot chosen',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_lump_sum', label: '', value: 100 }],
  }
  const unselectedImpact = calculateScenarioImpact(unselectedScenario, data, 'me', 0)
  check('An action with no savingsPotId produces no pot impact and no throw', unselectedImpact.savingsPotImpacts.length, 0)
}

console.log("\n2. Adam's real backup, as of a fixed date")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json', 'utf8'))
  const ledgerData: AppDataV2 = migrateLedgerData(raw.data ?? raw)
  const asOf = new Date(2026, 8, 17, 9, 30) // 17 Sep 2026, matching Batch 21's own fixed date
  const data = buildLegacyAppData(ledgerData, asOf)
  const pot = data.savingsPots.find((p) => p.name === 'Savings')
  checkTrue("Adam's 'Savings' pot is exposed", Boolean(pot), data.savingsPots.map((p) => p.name))
  checkTrue('It carries its real target (£10,000 by 31 Mar 2027)', pot?.targetAmount === 10000 && pot?.targetDate === '2027-03-31')

  const scenario: Scenario = {
    id: 'sc-real',
    name: 'Lump sum into Savings',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_lump_sum', label: '', value: 1000, savingsPotId: pot!.id }],
  }
  const impact = calculateScenarioImpact(scenario, data, data.primaryPersonId, 0)
  const potImpact = impact.savingsPotImpacts[0]
  checkTrue('Produces one savings-pot impact with a real balance', Boolean(potImpact) && potImpact!.balanceNow > 0, potImpact)

  // 🚨 Batch 21 lesson, proven directly: the pot's own £1,000/mo
  // follows-payday deposit ("Savings Deposit") must be counted, and
  // resolved to its real PAID date, not its slot. Rebuild the impact
  // with the recurring templates stripped (the deposit vanishes
  // entirely — a big, obvious balance drop) and again with the pay cycle
  // stripped (the deposit still happens, just dated wrong — see below
  // for why that shows up in the target date, not the 12-month total).
  const dataNoTemplates = { ...data, recurringTemplates: [] }
  const dataNoPayCycle = { ...data, payCycles: [] }
  const impactNoTemplates = calculateScenarioImpact(scenario, dataNoTemplates, data.primaryPersonId, 0)
  const impactNoPayCycle = calculateScenarioImpact(scenario, dataNoPayCycle, data.primaryPersonId, 0)
  const projectedReal = potImpact!.projectedBalanceBefore
  const projectedNoTemplates = impactNoTemplates.savingsPotImpacts[0]!.projectedBalanceBefore
  const projectedNoPayCycle = impactNoPayCycle.savingsPotImpacts[0]!.projectedBalanceBefore
  checkTrue(
    'Without the recurring templates, the 12-month projection is meaningfully lower (the £1,000/mo deposit is silently dropped)',
    projectedReal - projectedNoTemplates > 1000,
    { projectedReal, projectedNoTemplates },
  )
  // Adam's pot credits interest monthly (not daily), so a deposit landing
  // a few days later within the same month doesn't move a 12-month
  // CUMULATIVE balance — the two are genuinely equal here, which is why
  // this checks the resolved TARGET DATE instead (§1.13a: the slot
  // 12 Sep vs the resolved payday 30 Sep is an 18-day gap that a
  // target-date THRESHOLD crossing is sensitive to, even when the
  // monthly total isn't).
  checkTrue(
    'Without the pay cycle, projected balance is unaffected (monthly-credited interest ignores day-of-month) but the target date still moves — proving the resolved payday date, not just the deposit amount, depends on payCycle',
    projectedReal === projectedNoPayCycle,
    { projectedReal, projectedNoPayCycle },
  )
  const targetDateNoPayCycle = impactNoPayCycle.savingsPotImpacts[0]!.newTargetDate
  checkTrue(
    "Without the pay cycle, the new target date resolves to the transfer's SLOT (12th) rather than its paid date (30th/28th) — a real, different date, proving payCycle is load-bearing here",
    Boolean(potImpact!.newTargetDate) && Boolean(targetDateNoPayCycle) && potImpact!.newTargetDate !== targetDateNoPayCycle,
    { withPayCycle: potImpact!.newTargetDate, withoutPayCycle: targetDateNoPayCycle },
  )

  // Time saved must use the RESOLVED (paid) date, never originalDate —
  // §1.13a's own rule, re-proven here at the scenario-engine layer.
  checkTrue('Time saved is a finite number, not NaN/undefined (the resolved-date walk completed)', typeof potImpact!.monthsSaved === 'number' && Number.isFinite(potImpact!.monthsSaved))
}

console.log("\n3. Mum's real backup (no savings pots at all)")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15-mum.json', 'utf8'))
  const ledgerData: AppDataV2 = migrateLedgerData(raw.data ?? raw)
  const asOf = new Date(2026, 8, 17, 9, 30)
  const data = buildLegacyAppData(ledgerData, asOf)
  check('No savings pots at all', data.savingsPots.length, 0)

  const scenario: Scenario = {
    id: 'sc-mum',
    name: 'Would-be pot action',
    includeInCumulative: true,
    actions: [{ id: 'a1', type: 'savings_pot_lump_sum', label: '', value: 100, savingsPotId: 'nonexistent' }],
  }
  let threw = false
  let impact: ReturnType<typeof calculateScenarioImpact> | undefined
  try {
    impact = calculateScenarioImpact(scenario, data, data.primaryPersonId, 0)
  } catch {
    threw = true
  }
  checkTrue('No pots + a pot action referencing a nonexistent id does not throw', !threw)
  check('...and produces no pot actions', impact?.savingsPotImpacts.length, 0)
}

console.log(failures === 0 ? '\nAll savings-pot scenario checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
