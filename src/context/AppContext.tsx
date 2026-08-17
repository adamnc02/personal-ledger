import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AppData, Person, Bill, Loan, Scenario } from '../types/models'
import { defaultAppData, loadAppData, saveAppData } from '../lib/storage'
import { nanoid } from 'nanoid'

interface AppContextValue {
  data: AppData
  setData: (data: AppData) => void

  addPerson: (person: Omit<Person, 'id'>) => string
  updatePerson: (id: string, updates: Partial<Omit<Person, 'id'>>) => void
  removePerson: (id: string) => void
  setPrimaryPerson: (id: string) => void

  addBill: (bill: Omit<Bill, 'id'>) => string
  updateBill: (id: string, updates: Partial<Omit<Bill, 'id'>>) => void
  removeBill: (id: string) => void
  replaceBills: (bills: Bill[]) => void

  addLoan: (loan: Omit<Loan, 'id'>) => string
  updateLoan: (id: string, updates: Partial<Omit<Loan, 'id'>>) => void
  removeLoan: (id: string) => void
  replaceLoans: (loans: Loan[]) => void

  addScenario: (scenario: Omit<Scenario, 'id'>) => string
  updateScenario: (id: string, updates: Partial<Omit<Scenario, 'id'>>) => void
  removeScenario: (id: string) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setDataState] = useState<AppData>(() => loadAppData() ?? defaultAppData())

  useEffect(() => {
    saveAppData(data)
  }, [data])

  const setData = (next: AppData) => setDataState(next)

  const addPerson: AppContextValue['addPerson'] = (person) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, people: [...prev.people, { ...person, id }] }))
    return id
  }
  const updatePerson: AppContextValue['updatePerson'] = (id, updates) => {
    setDataState((prev) => ({
      ...prev,
      people: prev.people.map((p) => (p.id === id ? { ...p, ...updates, salary: { ...p.salary, ...updates.salary } } : p)),
    }))
  }
  const removePerson: AppContextValue['removePerson'] = (id) => {
    setDataState((prev) => {
      const people = prev.people.filter((p) => p.id !== id)
      // If the person marked "Me" gets removed, fall back to whoever's left
      // rather than leaving primaryPersonId pointing at nobody.
      const primaryPersonId = prev.primaryPersonId === id ? (people[0]?.id ?? '') : prev.primaryPersonId
      return { ...prev, people, primaryPersonId }
    })
  }
  const setPrimaryPerson: AppContextValue['setPrimaryPerson'] = (id) => {
    setDataState((prev) => ({ ...prev, primaryPersonId: id }))
  }

  const addBill: AppContextValue['addBill'] = (bill) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, bills: [...prev.bills, { ...bill, id }] }))
    return id
  }
  const updateBill: AppContextValue['updateBill'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, bills: prev.bills.map((b) => (b.id === id ? { ...b, ...updates } : b)) }))
  }
  const removeBill: AppContextValue['removeBill'] = (id) => {
    setDataState((prev) => ({ ...prev, bills: prev.bills.filter((b) => b.id !== id) }))
  }
  const replaceBills: AppContextValue['replaceBills'] = (bills) => {
    setDataState((prev) => ({ ...prev, bills }))
  }

  const addLoan: AppContextValue['addLoan'] = (loan) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, loans: [...prev.loans, { ...loan, id }] }))
    return id
  }
  const updateLoan: AppContextValue['updateLoan'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, loans: prev.loans.map((l) => (l.id === id ? { ...l, ...updates } : l)) }))
  }
  const removeLoan: AppContextValue['removeLoan'] = (id) => {
    setDataState((prev) => ({ ...prev, loans: prev.loans.filter((l) => l.id !== id) }))
  }
  const replaceLoans: AppContextValue['replaceLoans'] = (loans) => {
    setDataState((prev) => ({ ...prev, loans }))
  }

  const addScenario: AppContextValue['addScenario'] = (scenario) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, scenarios: [...prev.scenarios, { ...scenario, id }] }))
    return id
  }
  const updateScenario: AppContextValue['updateScenario'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, scenarios: prev.scenarios.map((s) => (s.id === id ? { ...s, ...updates } : s)) }))
  }
  const removeScenario: AppContextValue['removeScenario'] = (id) => {
    setDataState((prev) => ({ ...prev, scenarios: prev.scenarios.filter((s) => s.id !== id) }))
  }

  return (
    <AppContext.Provider
      value={{
        data,
        setData,
        addPerson,
        updatePerson,
        removePerson,
        setPrimaryPerson,
        addBill,
        updateBill,
        removeBill,
        replaceBills,
        addLoan,
        updateLoan,
        removeLoan,
        replaceLoans,
        addScenario,
        updateScenario,
        removeScenario,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useAppData(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppData must be used within an AppProvider')
  return ctx
}
