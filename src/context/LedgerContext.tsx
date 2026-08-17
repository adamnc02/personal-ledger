import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { nanoid } from 'nanoid'
import type {
  AppDataV2,
  Category,
  CreditCard,
  Loan,
  PayCycleConfig,
  PaymentMethod,
  Person,
  RecurringTemplate,
  SalaryOverride,
  SalarySnapshot,
  SavingsEntry,
  Transaction,
} from '../types/ledger'
import type { Scenario } from '../types/models'
import { defaultLedgerData, defaultPayCycleConfig, loadLedgerData, saveLedgerData } from '../lib/ledgerStorage'
import { createCategory, removeCategorySafely } from '../lib/categories'
import { recordCreditCardSpend, recordCreditCardLumpPayment } from '../lib/creditCards'
import { applyLoanOverpayment } from '../lib/ledgerLoans'
import { autoClearDuePayments } from '../lib/autoClear'
import { applyClearSideEffects } from '../lib/clearTransaction'

import { toLocalIsoDate as toIso } from '../lib/date'
const todayIso = () => toIso(new Date())

interface AdHocInput {
  type: 'expense' | 'income' | 'bonus'
  amount: number
  date: string // ISO date
  categoryId: string
  paymentMethod: PaymentMethod
  personId: string
  note?: string
}

interface LedgerContextValue {
  data: AppDataV2
  setData: (data: AppDataV2) => void

  addCategory: (name: string, overrides?: { icon?: string; iconColor?: string }) => Category
  updateCategory: (id: string, updates: Partial<Omit<Category, 'id'>>) => void
  /** No-ops for built-in categories (isBuiltIn: true) — those can be renamed via updateCategory but never deleted, since transactions are hard-forced onto them (see CREDIT_CARD_CATEGORY_ID in types/ledger.ts). */
  removeCategory: (id: string) => void

  /** Plain ad-hoc expense/income/bonus — never touches a credit card. Status defaults to 'cleared' if dated today or earlier, 'pending' if dated in the future. */
  addAdHocTransaction: (input: AdHocInput) => void
  /** Edits any transaction in place — used for correcting/renaming an ad-hoc entry after the fact. Does NOT re-run the credit-card-balance side effects that logCreditCardSpend/logCreditCardLumpPayment apply on creation — editing the amount of an already-recorded card transaction does not retroactively adjust that card's currentBalance. Delete and re-log if the card balance itself needs correcting. */
  updateTransaction: (id: string, updates: Partial<Omit<Transaction, 'id'>>) => void
  removeTransaction: (id: string) => void

  /** A purchase charged to a specific credit card — creates a credit_card_spend transaction and bumps that card's currentBalance, per the confirmed design (see types/ledger.ts). */
  logCreditCardSpend: (cardId: string, amount: number, date: string, note?: string) => void
  /** An ad-hoc/lump payment toward a card, made right now — reduces that card's currentBalance and creates the matching negative-on-Personal-card transaction. */
  logCreditCardLumpPayment: (cardId: string, amount: number, date: string, note?: string) => void
  /** Removes a logged lump payment entirely — the log record AND its transaction. If that transaction had already cleared (balance already reduced), correctly reverses that reduction first. */
  removeCreditCardLumpPayment: (cardId: string, lumpPaymentId: string) => void
  /** Edits a logged lump payment's amount/date/note. Implemented as reverse-then-relog internally (not an in-place field patch) — that reuses the exact same clearing logic a fresh log goes through, rather than hand-rolling every possible before/after balance transition. */
  updateCreditCardLumpPayment: (cardId: string, lumpPaymentId: string, amount: number, date: string, note?: string) => void

  addLoan: (loan: Omit<Loan, 'id' | 'overpayments'>) => string
  updateLoan: (id: string, updates: Partial<Omit<Loan, 'id' | 'overpayments'>>) => void
  removeLoan: (id: string) => void
  /** Records a real overpayment against a loan right now — updates the loan's overpayments (shrinking its remaining schedule) and inserts the matching cleared loan_payment transaction. Unrelated to the What-if page's hypothetical overpayment scenario action. */
  logLoanOverpayment: (loanId: string, amount: number, date: string, note?: string) => void

  addCreditCard: (card: Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>) => string
  updateCreditCard: (id: string, updates: Partial<Omit<CreditCard, 'id'>>) => void
  removeCreditCard: (id: string) => void

  addRecurringTemplate: (template: Omit<RecurringTemplate, 'id' | 'active'>) => string
  updateRecurringTemplate: (id: string, updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  removeRecurringTemplate: (id: string) => void

  // People, pay cycle, salary, savings — the piece that was previously
  // still running on the old AppContext entirely (see Salary.tsx).
  addPerson: (input: { name: string; color: string }) => string
  updatePerson: (id: string, updates: Partial<Pick<Person, 'name' | 'color'>>) => void
  /** Refuses to remove the last remaining person — there must always be at least one. Reassigns primaryPersonId to another person if the primary is removed. Also removes that person's PayCycleConfig. */
  removePerson: (id: string) => void
  setPrimaryPerson: (id: string) => void

  /** Upserts — creates a PayCycleConfig for this person if one doesn't exist yet, otherwise patches the existing one. */
  updatePayCycle: (personId: string, updates: Partial<Omit<PayCycleConfig, 'personId'>>) => void

  /** A "permanent" salary change — a new dated snapshot, effective going forward. See SalaryOverride for the "one-off" case. */
  addSalarySnapshot: (personId: string, snapshot: Omit<SalarySnapshot, 'id' | 'personId'>) => string
  updateSalarySnapshot: (personId: string, snapshotId: string, updates: Partial<Omit<SalarySnapshot, 'id' | 'personId'>>) => void
  removeSalarySnapshot: (personId: string, snapshotId: string) => void

  addSalaryOverride: (personId: string, override: Omit<SalaryOverride, 'id' | 'personId'>) => string
  updateSalaryOverride: (personId: string, overrideId: string, updates: Partial<Omit<SalaryOverride, 'id' | 'personId'>>) => void
  removeSalaryOverride: (personId: string, overrideId: string) => void

  addSavingsEntry: (personId: string, entry: Omit<SavingsEntry, 'id'>) => string
  updateSavingsEntry: (personId: string, entryId: string, updates: Partial<Omit<SavingsEntry, 'id'>>) => void
  removeSavingsEntry: (personId: string, entryId: string) => void

  // What-if scenarios — data storage only. See lib/legacyBridge.ts for
  // how the scenario ENGINE itself gets fed real ledger data.
  addScenario: (scenario: Omit<Scenario, 'id'>) => string
  updateScenario: (id: string, updates: Partial<Omit<Scenario, 'id'>>) => void
  removeScenario: (id: string) => void
}

const LedgerContext = createContext<LedgerContextValue | null>(null)

export function LedgerProvider({ children }: { children: ReactNode }) {
  const [data, setDataState] = useState<AppDataV2>(() => loadLedgerData() ?? defaultLedgerData())

  useEffect(() => {
    saveLedgerData(data)
  }, [data])

  // Automatic clearing — runs on every data load/change. autoClearDuePayments
  // returns the SAME `data` reference when there's nothing new to settle,
  // so this only ever calls setDataState when something genuinely came
  // due since the last check, which prevents an infinite update loop.
  useEffect(() => {
    const settled = autoClearDuePayments(data)
    if (settled !== data) setDataState(settled)
  }, [data])

  const setData = (next: AppDataV2) => setDataState(next)

  const addCategory: LedgerContextValue['addCategory'] = (name, overrides) => {
    let created: Category | undefined
    setDataState((prev) => {
      created = createCategory(name, prev.categories, overrides)
      return { ...prev, categories: [...prev.categories, created] }
    })
    // created is always assigned synchronously above before this line runs,
    // since setDataState's updater executes immediately in this render pass.
    return created!
  }

  const updateCategory: LedgerContextValue['updateCategory'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, categories: prev.categories.map((c) => (c.id === id ? { ...c, ...updates } : c)) }))
  }

  const removeCategory: LedgerContextValue['removeCategory'] = (id) => {
    setDataState((prev) => ({ ...prev, categories: removeCategorySafely(prev.categories, id) }))
  }

  const addAdHocTransaction: LedgerContextValue['addAdHocTransaction'] = (input) => {
    const transaction: Transaction = {
      id: nanoid(8),
      date: input.date,
      amount: input.amount,
      direction: input.type === 'expense' ? 'out' : 'in',
      categoryId: input.categoryId,
      paymentMethod: input.paymentMethod,
      status: input.date <= todayIso() ? 'cleared' : 'pending',
      type: input.type,
      location: 'personal',
      ownerId: input.personId,
      personId: input.type === 'income' || input.type === 'bonus' ? input.personId : undefined,
      note: input.note,
    }
    setDataState((prev) => ({ ...prev, transactions: [...prev.transactions, transaction] }))
  }

  const updateTransaction: LedgerContextValue['updateTransaction'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, transactions: prev.transactions.map((t) => (t.id === id ? { ...t, ...updates } : t)) }))
  }

  const removeTransaction: LedgerContextValue['removeTransaction'] = (id) => {
    setDataState((prev) => ({ ...prev, transactions: prev.transactions.filter((t) => t.id !== id) }))
  }

  const logCreditCardSpend: LedgerContextValue['logCreditCardSpend'] = (cardId, amount, date, note) => {
    setDataState((prev) => {
      const card = prev.creditCards.find((c) => c.id === cardId)
      if (!card) return prev
      const { updatedCard, transaction } = recordCreditCardSpend(card, amount, date, note)
      return {
        ...prev,
        creditCards: prev.creditCards.map((c) => (c.id === cardId ? updatedCard : c)),
        transactions: [...prev.transactions, { ...transaction, id: nanoid(8) }],
      }
    })
  }

  const logCreditCardLumpPayment: LedgerContextValue['logCreditCardLumpPayment'] = (cardId, amount, date, note) => {
    setDataState((prev) => {
      const card = prev.creditCards.find((c) => c.id === cardId)
      if (!card) return prev
      const { updatedCard, transaction } = recordCreditCardLumpPayment(card, amount, date, note)
      const withTransaction = {
        ...prev,
        creditCards: prev.creditCards.map((c) => (c.id === cardId ? updatedCard : c)),
        transactions: [...prev.transactions, { ...transaction, id: nanoid(8) }],
      }
      // A same-day/past-dated payment clears immediately — apply its
      // balance effect right away rather than waiting for the next
      // auto-clear pass, so there's no momentary flash of an
      // un-reduced balance. A future-dated one stays untouched here;
      // autoClearDuePayments picks it up once its date actually arrives.
      if (transaction.status === 'cleared') {
        return applyClearSideEffects(withTransaction, { ...transaction, id: withTransaction.transactions.at(-1)!.id })
      }
      return withTransaction
    })
  }

  const removeCreditCardLumpPayment: LedgerContextValue['removeCreditCardLumpPayment'] = (cardId, lumpPaymentId) => {
    setDataState((prev) => {
      const card = prev.creditCards.find((c) => c.id === cardId)
      if (!card) return prev
      const transaction = prev.transactions.find((t) => t.sourceType === 'credit_card_lump_payment' && t.sourceId === lumpPaymentId)

      let updatedCard = { ...card, lumpPayments: card.lumpPayments.filter((lp) => lp.id !== lumpPaymentId) }
      // If it had already cleared, its amount is already baked into
      // currentBalance — reverse that before removing it, or the
      // balance would be permanently understated.
      if (transaction && transaction.status === 'cleared') {
        updatedCard = { ...updatedCard, currentBalance: Math.round((updatedCard.currentBalance + transaction.amount) * 100) / 100 }
      }

      return {
        ...prev,
        creditCards: prev.creditCards.map((c) => (c.id === cardId ? updatedCard : c)),
        transactions: transaction ? prev.transactions.filter((t) => t.id !== transaction.id) : prev.transactions,
      }
    })
  }

  const updateCreditCardLumpPayment: LedgerContextValue['updateCreditCardLumpPayment'] = (cardId, lumpPaymentId, amount, date, note) => {
    setDataState((prev) => {
      const card = prev.creditCards.find((c) => c.id === cardId)
      if (!card) return prev
      const oldTransaction = prev.transactions.find((t) => t.sourceType === 'credit_card_lump_payment' && t.sourceId === lumpPaymentId)

      // Reverse-then-relog: undo the old entry's effect entirely (log
      // record + balance reversal if it had cleared + its transaction),
      // then log the new values fresh through the exact same path a
      // brand-new payment goes through. Deliberately not an in-place
      // field patch — that would mean re-deriving every possible
      // before/after balance transition by hand instead of reusing the
      // one, already-tested code path that already handles all of them.
      let workingCard: typeof card = { ...card, lumpPayments: card.lumpPayments.filter((lp) => lp.id !== lumpPaymentId) }
      if (oldTransaction && oldTransaction.status === 'cleared') {
        workingCard = { ...workingCard, currentBalance: Math.round((workingCard.currentBalance + oldTransaction.amount) * 100) / 100 }
      }
      let transactions = oldTransaction ? prev.transactions.filter((t) => t.id !== oldTransaction.id) : prev.transactions

      const { updatedCard, transaction: newTransaction } = recordCreditCardLumpPayment(workingCard, amount, date, note)
      const newTransactionWithId = { ...newTransaction, id: nanoid(8) }
      transactions = [...transactions, newTransactionWithId]

      let finalCard = updatedCard
      if (newTransactionWithId.status === 'cleared') {
        const applied = applyClearSideEffects({ ...prev, creditCards: prev.creditCards.map((c) => (c.id === cardId ? updatedCard : c)), transactions }, newTransactionWithId)
        finalCard = applied.creditCards.find((c) => c.id === cardId)!
      }

      return {
        ...prev,
        creditCards: prev.creditCards.map((c) => (c.id === cardId ? finalCard : c)),
        transactions,
      }
    })
  }

  const addLoan: LedgerContextValue['addLoan'] = (loan) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, loans: [...prev.loans, { ...loan, id, overpayments: [] }] }))
    return id
  }
  const updateLoan: LedgerContextValue['updateLoan'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, loans: prev.loans.map((l) => (l.id === id ? { ...l, ...updates } : l)) }))
  }
  const removeLoan: LedgerContextValue['removeLoan'] = (id) => {
    setDataState((prev) => ({ ...prev, loans: prev.loans.filter((l) => l.id !== id) }))
  }
  const logLoanOverpayment: LedgerContextValue['logLoanOverpayment'] = (loanId, amount, date, note) => {
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === loanId)
      if (!loan) return prev
      const { updatedLoan, transaction } = applyLoanOverpayment(loan, amount, date, note)
      return {
        ...prev,
        loans: prev.loans.map((l) => (l.id === loanId ? updatedLoan : l)),
        transactions: [...prev.transactions, { ...transaction, id: nanoid(8) }],
      }
    })
  }

  const addCreditCard: LedgerContextValue['addCreditCard'] = (card) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, creditCards: [...prev.creditCards, { ...card, id, lumpPayments: [], active: true }] }))
    return id
  }
  const updateCreditCard: LedgerContextValue['updateCreditCard'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, creditCards: prev.creditCards.map((c) => (c.id === id ? { ...c, ...updates } : c)) }))
  }
  const removeCreditCard: LedgerContextValue['removeCreditCard'] = (id) => {
    setDataState((prev) => ({ ...prev, creditCards: prev.creditCards.filter((c) => c.id !== id) }))
  }

  const addRecurringTemplate: LedgerContextValue['addRecurringTemplate'] = (template) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, recurringTemplates: [...prev.recurringTemplates, { ...template, id, active: true }] }))
    return id
  }
  const updateRecurringTemplate: LedgerContextValue['updateRecurringTemplate'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, recurringTemplates: prev.recurringTemplates.map((t) => (t.id === id ? { ...t, ...updates } : t)) }))
  }
  const removeRecurringTemplate: LedgerContextValue['removeRecurringTemplate'] = (id) => {
    setDataState((prev) => ({ ...prev, recurringTemplates: prev.recurringTemplates.filter((t) => t.id !== id) }))
  }

  const addPerson: LedgerContextValue['addPerson'] = ({ name, color }) => {
    const id = nanoid(8)
    const person: Person = { id, name, color, salaryHistory: [], salaryOverrides: [], savingsEntries: [] }
    setDataState((prev) => ({
      ...prev,
      people: [...prev.people, person],
      payCycles: [...prev.payCycles, defaultPayCycleConfig(id)],
    }))
    return id
  }
  const updatePerson: LedgerContextValue['updatePerson'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, people: prev.people.map((p) => (p.id === id ? { ...p, ...updates } : p)) }))
  }
  const removePerson: LedgerContextValue['removePerson'] = (id) => {
    setDataState((prev) => {
      if (prev.people.length <= 1) return prev // always at least one person
      const remaining = prev.people.filter((p) => p.id !== id)
      return {
        ...prev,
        people: remaining,
        payCycles: prev.payCycles.filter((pc) => pc.personId !== id),
        primaryPersonId: prev.primaryPersonId === id ? remaining[0].id : prev.primaryPersonId,
      }
    })
  }
  const setPrimaryPerson: LedgerContextValue['setPrimaryPerson'] = (id) => {
    setDataState((prev) => ({ ...prev, primaryPersonId: id }))
  }

  const updatePayCycle: LedgerContextValue['updatePayCycle'] = (personId, updates) => {
    setDataState((prev) => {
      const exists = prev.payCycles.some((pc) => pc.personId === personId)
      const payCycles = exists
        ? prev.payCycles.map((pc) => (pc.personId === personId ? { ...pc, ...updates } : pc))
        : [...prev.payCycles, { ...defaultPayCycleConfig(personId), ...updates }]
      return { ...prev, payCycles }
    })
  }

  const addSalarySnapshot: LedgerContextValue['addSalarySnapshot'] = (personId, snapshot) => {
    const id = nanoid(8)
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, salaryHistory: [...p.salaryHistory, { ...snapshot, id, personId }] } : p)),
    }))
    return id
  }
  const updateSalarySnapshot: LedgerContextValue['updateSalarySnapshot'] = (personId, snapshotId, updates) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) =>
        p.id === personId ? { ...p, salaryHistory: p.salaryHistory.map((s) => (s.id === snapshotId ? { ...s, ...updates } : s)) } : p,
      ),
    }))
  }
  const removeSalarySnapshot: LedgerContextValue['removeSalarySnapshot'] = (personId, snapshotId) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, salaryHistory: p.salaryHistory.filter((s) => s.id !== snapshotId) } : p)),
    }))
  }

  const addSalaryOverride: LedgerContextValue['addSalaryOverride'] = (personId, override) => {
    const id = nanoid(8)
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, salaryOverrides: [...p.salaryOverrides, { ...override, id, personId }] } : p)),
    }))
    return id
  }
  const updateSalaryOverride: LedgerContextValue['updateSalaryOverride'] = (personId, overrideId, updates) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) =>
        p.id === personId ? { ...p, salaryOverrides: p.salaryOverrides.map((o) => (o.id === overrideId ? { ...o, ...updates } : o)) } : p,
      ),
    }))
  }
  const removeSalaryOverride: LedgerContextValue['removeSalaryOverride'] = (personId, overrideId) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, salaryOverrides: p.salaryOverrides.filter((o) => o.id !== overrideId) } : p)),
    }))
  }

  const addSavingsEntry: LedgerContextValue['addSavingsEntry'] = (personId, entry) => {
    const id = nanoid(8)
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, savingsEntries: [...p.savingsEntries, { ...entry, id }] } : p)),
    }))
    return id
  }
  const updateSavingsEntry: LedgerContextValue['updateSavingsEntry'] = (personId, entryId, updates) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) =>
        p.id === personId ? { ...p, savingsEntries: p.savingsEntries.map((e) => (e.id === entryId ? { ...e, ...updates } : e)) } : p,
      ),
    }))
  }
  const removeSavingsEntry: LedgerContextValue['removeSavingsEntry'] = (personId, entryId) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === personId ? { ...p, savingsEntries: p.savingsEntries.filter((e) => e.id !== entryId) } : p)),
    }))
  }

  const addScenario: LedgerContextValue['addScenario'] = (scenario) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, scenarios: [...prev.scenarios, { ...scenario, id }] }))
    return id
  }
  const updateScenario: LedgerContextValue['updateScenario'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, scenarios: prev.scenarios.map((s) => (s.id === id ? { ...s, ...updates } : s)) }))
  }
  const removeScenario: LedgerContextValue['removeScenario'] = (id) => {
    setDataState((prev) => ({ ...prev, scenarios: prev.scenarios.filter((s) => s.id !== id) }))
  }

  const value: LedgerContextValue = {
    data,
    setData,
    addCategory,
    updateCategory,
    removeCategory,
    addAdHocTransaction,
    updateTransaction,
    removeTransaction,
    logCreditCardSpend,
    logCreditCardLumpPayment,
    removeCreditCardLumpPayment,
    updateCreditCardLumpPayment,
    addLoan,
    updateLoan,
    removeLoan,
    logLoanOverpayment,
    addCreditCard,
    updateCreditCard,
    removeCreditCard,
    addRecurringTemplate,
    updateRecurringTemplate,
    removeRecurringTemplate,
    addPerson,
    updatePerson,
    removePerson,
    setPrimaryPerson,
    updatePayCycle,
    addSalarySnapshot,
    updateSalarySnapshot,
    removeSalarySnapshot,
    addSalaryOverride,
    updateSalaryOverride,
    removeSalaryOverride,
    addSavingsEntry,
    updateSavingsEntry,
    removeSavingsEntry,
    addScenario,
    updateScenario,
    removeScenario,
  }

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>
}

export function useLedgerData(): LedgerContextValue {
  const ctx = useContext(LedgerContext)
  if (!ctx) throw new Error('useLedgerData must be used within a LedgerProvider')
  return ctx
}
