// Persistence for the new ledger data model. Deliberately a separate
// storage key from the legacy AppData ('ledger:app-data:v1', see
// storage.ts) — the two live side by side during the rebuild rather than
// one migrating into the other, since the doc treats this as a genuinely
// new application, not an in-place schema migration (Section 4).

import { nanoid } from 'nanoid'
import type { AppDataV2, PayCycleConfig, Person } from '../types/ledger'
import { defaultCategories } from './categories'
import { toLocalIsoDate } from './date'

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

  return {
    ...data,
    people: data.people ?? [],
    categories: [...categories, ...missingBuiltIns],
    recurringTemplates: data.recurringTemplates ?? [],
    loans: data.loans ?? [],
    creditCards: data.creditCards ?? [],
    transactions: data.transactions ?? [],
    payCycles: data.payCycles ?? [],
    scenarios: data.scenarios ?? [],
  }
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
