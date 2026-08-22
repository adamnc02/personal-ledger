// Persistence for the new ledger data model. Deliberately a separate
// storage key from the legacy AppData ('ledger:app-data:v1', see
// storage.ts) — the two live side by side during the rebuild rather than
// one migrating into the other, since the doc treats this as a genuinely
// new application, not an in-place schema migration (Section 4).

import { nanoid } from 'nanoid'
import type { AppDataV2, CreditCard, PayCycleConfig, Person, Transaction } from '../types/ledger'
import { defaultCategories } from './categories'
import { reconcilePersonReferences } from './household'
import { monthlyInterestRate } from './creditCards'
import { toLocalIsoDate } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

const STORAGE_KEY = 'ledger:app-data-v2:v1'

export function loadLedgerData(): AppDataV2 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return migrateLedgerData(JSON.parse(raw))
  } catch (err) {
    console.error('Failed to load ledger data', err)
    return null
  }
}

/**
 * Backfills fields introduced in later schema versions. Also ensures
 * every BUILT-IN category (Credit Card, Income, Bills, Savings) exists —
 * a category list already persisted to localStorage from before one of
 * these was introduced would otherwise never gain it automatically, and
 * every generated transaction that's hard-forced onto it (e.g. every
 * savings_contribution onto Savings) would show as "Uncategorised"
 * forever. Only ADDS missing built-ins by id; never touches existing
 * categories, built-in or otherwise, so a renamed "Bills" or any
 * user-created category is left completely alone.
 */
export function migrateLedgerData(data: AppDataV2): AppDataV2 {
  const categories = data.categories ?? []
  const existingIds = new Set(categories.map((c) => c.id))
  const missingBuiltIns = defaultCategories().filter((c) => c.isBuiltIn && !existingIds.has(c.id))

  const backfilled: AppDataV2 = {
    ...data,
    people: data.people ?? [],
    categories: [...categories, ...missingBuiltIns],
    recurringTemplates: data.recurringTemplates ?? [],
    // `active` was introduced by the amortisation-engine work (scope §7),
    // mirroring CreditCard.active — any loan persisted before that field
    // existed backfills to true (still open/ongoing), same reasoning as
    // the built-in-category backfill above: never silently hide or
    // deactivate something the person never touched. Every other new
    // loan field (lender, advanceDate, calibration data) is genuinely
    // optional at the type level and needs no backfill.
    //
    // `principal` is a NEW REQUIRED field (same scope of work) — a loan
    // persisted before it existed has no real record of what was
    // actually borrowed, only monthlyPayment × termMonths (the old flat
    // model's "total payable", which is what the amortisation engine's
    // baseline back-solve would treat as a 0%-interest loan if left as
    // the principal too). Backfilling to that same figure is the only
    // information-preserving default available — it reproduces the old
    // flat model's numbers exactly (0% effective rate) until the person
    // corrects it with the real amount borrowed via the loan's edit view,
    // rather than guessing a non-zero rate from nothing.
    loans: (data.loans ?? []).map((loan) => ({
      ...loan,
      active: loan.active ?? true,
      principal: loan.principal ?? round2(loan.monthlyPayment * loan.termMonths),
    })),
    // `balanceAsOfDate` is a NEW REQUIRED field (see the comment on
    // CreditCard in types/ledger.ts). It's backfilled to TODAY, and that
    // choice is load-bearing rather than arbitrary: under the old model
    // `currentBalance` was a running total that had ALREADY been
    // decremented by every payment that cleared. Anchoring it to any
    // earlier date would make the new replay subtract those same
    // payments a second time. "As of today" is the one date for which
    // the existing stored figure is, by construction, already correct.
    //
    // The one wrinkle is a card transaction dated TODAY: the old code
    // subtracted it from currentBalance the moment it cleared, and the
    // replay counts anything dated on or before today, so it would land
    // twice. Those are reversed back out below so the anchor represents
    // the balance BEFORE today's activity, which the replay then
    // re-applies. Guarded on `balanceAsOfDate === undefined`, so this
    // runs exactly once per card and re-running migration on
    // already-migrated data is a no-op.
    creditCards: (data.creditCards ?? []).map((card) => (card.balanceAsOfDate ? card : anchorLegacyCardBalance(card, data.transactions ?? []))),
    transactions: data.transactions ?? [],
    payCycles: data.payCycles ?? [],
    scenarios: data.scenarios ?? [],
  }

  // Self-heals any bill/loan/card left pointing at a person who no longer
  // exists — see lib/household.ts's reconcilePersonReferences for why.
  return reconcilePersonReferences(backfilled)
}

export function saveLedgerData(data: AppDataV2): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('Failed to save ledger data', err)
  }
}

export function downloadLedgerBackup(data: AppDataV2): void {
  const json = JSON.stringify(data, null, 2)
  const date = toLocalIsoDate(new Date())
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `finance-ledger-backup-${date}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function parseLedgerBackupJson(json: string): AppDataV2 {
  const parsed = JSON.parse(json)
  const raw: unknown = parsed?.data ?? parsed // accept either a wrapped backup or a raw AppDataV2 dump

  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AppDataV2).people)) {
    throw new Error("This doesn't look like a Finance ledger backup file.")
  }

  return migrateLedgerData(raw as AppDataV2)
}

export function defaultPayCycleConfig(personId: string): PayCycleConfig {
  return {
    personId,
    openingBalance: 0,
    openingBalanceDate: toLocalIsoDate(new Date()),
    paydayDayOfMonth: 28,
    paydayAdjustForNonWorkingDay: true,
    cycleStartDayOfMonth: 1,
  }
}

export function defaultLedgerData(): AppDataV2 {
  const meId = nanoid(8)
  const me: Person = {
    id: meId,
    name: 'Me',
    color: '#ff5b4c',
    salaryHistory: [],
    salaryOverrides: [],
    savingsEntries: [],
  }

  return {
    primaryPersonId: meId,
    people: [me],
    categories: defaultCategories(),
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [defaultPayCycleConfig(meId)],
    scenarios: [],
  }
}

/**
 * One-time backfill of a pre-`balanceAsOfDate` credit card. See the call
 * site in migrateLedgerData for why the anchor date is today and why
 * today's own activity has to be unwound out of the stored figure first.
 *
 * Interest is unwound too, for the same reason the payment is: under the
 * old model a cleared GENERATED minimum payment posted a cycle's interest
 * to the balance before subtracting itself (applyClearSideEffects), so a
 * minimum payment that cleared today left both effects baked in. A logged
 * lump payment never posted interest, so only its amount is reversed.
 */
function anchorLegacyCardBalance(card: CreditCard, transactions: Transaction[]): CreditCard {
  const today = toLocalIsoDate(new Date())
  const todaysActivity = transactions.filter(
    (t) => t.creditCardId === card.id && t.date === today && (t.type === 'credit_card_spend' || t.type === 'credit_card_payment'),
  )

  let balance = card.currentBalance
  // Walk backwards through the day's events, undoing each in turn.
  for (const t of [...todaysActivity].reverse()) {
    if (t.type === 'credit_card_spend') {
      balance = round2(balance - t.amount)
    } else {
      balance = round2(balance + t.amount)
      const wasGeneratedMinimum = t.sourceType !== 'credit_card_lump_payment'
      if (wasGeneratedMinimum && card.interestRatePercent > 0) {
        balance = round2(balance / (1 + monthlyInterestRate(card.interestRatePercent)))
      }
    }
  }

  return { ...card, currentBalance: Math.max(0, balance), balanceAsOfDate: today }
}
