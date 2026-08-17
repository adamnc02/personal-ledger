import type { AppData, Person } from '../types/models'
import type { SalaryDeduction } from './tax'
import { toLocalIsoDate } from './date'
import { nanoid } from 'nanoid'

const STORAGE_KEY = 'ledger:app-data:v1'

export function loadAppData(): AppData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return migrateAppData(JSON.parse(raw))
  } catch (err) {
    console.error('Failed to load app data', err)
    return null
  }
}

/** Converts a person's salary settings from any earlier schema version into the current shape. */
function migrateSalary(salary: unknown): Person['salary'] {
  const s = (salary ?? {}) as Partial<Person['salary']> & { pensionType?: string; pensionPercent?: number }

  let deductions = s.deductions
  if (!deductions) {
    // Pre-deductions-list schema: a single pension field. Fold it into the
    // new list so existing users see the same number, just represented
    // as their first (and only) deduction now.
    deductions =
      s.pensionPercent && s.pensionPercent > 0
        ? [
            {
              id: nanoid(6),
              name: 'Pension',
              type: (s.pensionType as SalaryDeduction['type']) ?? 'relief_at_source',
              amountType: 'percent',
              amount: s.pensionPercent,
            },
          ]
        : []
  }

  return {
    grossAnnual: s.grossAnnual ?? 0,
    taxCode: s.taxCode ?? '1257L',
    studentLoanPlan: s.studentLoanPlan ?? 'none',
    payFrequency: s.payFrequency ?? 'monthly',
    deductions,
    employerPensionPercent: s.employerPensionPercent,
  }
}

/** Backfills fields introduced in later schema versions, for data saved by an earlier version of the app. */
export function migrateAppData(data: AppData): AppData {
  const fallbackPersonId = data.primaryPersonId ?? data.people[0]?.id ?? ''

  return {
    ...data,
    people: (data.people ?? []).map((p) => ({
      ...p,
      savingsEntries: p.savingsEntries ?? [],
      salary: migrateSalary(p.salary),
    })),
    bills: (data.bills ?? []).map((b) => ({
      ...b,
      payee: b.payee ?? '',
      payeeSharePercent: typeof b.payeeSharePercent === 'number' ? b.payeeSharePercent : 50,
    })),
    loans: (data.loans ?? []).map((l) => ({
      ...l,
      location: l.location ?? 'personal',
      ownerId: l.ownerId ?? fallbackPersonId,
      payee: l.payee ?? fallbackPersonId,
      payeeSharePercent: typeof l.payeeSharePercent === 'number' ? l.payeeSharePercent : 50,
    })),
    scenarios: (data.scenarios ?? []).map((s) => ({
      ...s,
      includeInCumulative: s.includeInCumulative ?? true,
    })),
  }
}

export function saveAppData(data: AppData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('Failed to save app data', err)
  }
}

export function defaultAppData(): AppData {
  const meId = nanoid(8)
  return {
    primaryPersonId: meId,
    people: [
      {
        id: meId,
        name: 'Me',
        color: '#ff5b4c',
        salary: {
          grossAnnual: 0,
          taxCode: '1257L',
          studentLoanPlan: 'none',
          payFrequency: 'monthly',
          deductions: [{ id: nanoid(6), name: 'Pension', type: 'relief_at_source', amountType: 'percent', amount: 5 }],
        },
        savingsEntries: [],
      },
    ],
    bills: [],
    loans: [],
    scenarios: [],
  }
}

// ---- Full app backup/restore ----
//
// Everything (people, salaries, bills, loans, scenarios) lives in
// localStorage, which Safari in particular can clear without warning
// (e.g. under storage pressure, or "Clear History and Website Data").
// This gives you a complete snapshot you can save somewhere durable —
// iCloud Drive, email to yourself, whatever — and restore from later.

export interface AppBackup {
  version: 1
  exportedAt: string
  app: 'finance'
  data: AppData
}

export function exportFullBackupToJson(data: AppData): string {
  const payload: AppBackup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'finance',
    data,
  }
  return JSON.stringify(payload, null, 2)
}

export function downloadFullBackup(data: AppData): void {
  const json = exportFullBackupToJson(data)
  const date = toLocalIsoDate(new Date())
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `finance-backup-${date}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function parseFullBackupJson(json: string): AppData {
  const parsed = JSON.parse(json)
  const raw: unknown = parsed?.data ?? parsed // accept either the wrapped backup format or a raw AppData dump

  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AppData).people)) {
    throw new Error('This doesn\'t look like a Finance backup file.')
  }

  return migrateAppData(raw as AppData)
}
