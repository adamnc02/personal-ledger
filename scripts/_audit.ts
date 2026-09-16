import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { scheduledTemplateDates, applyTemplateSingleOccurrenceDateChange } from '../src/lib/schedule'
import type { AppDataV2, Transaction } from '../src/types/ledger'
const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/'
const asOf = new Date(2026, 8, 16)
const mum = autoClearDuePayments(parseLedgerBackupJson(readFileSync(DIR + 'finance-ledger-backup-2026-09-15-mum.json', 'utf8')), asOf)
const adam = autoClearDuePayments(parseLedgerBackupJson(readFileSync(DIR + 'finance-ledger-backup-2026-09-15.json', 'utf8')), asOf)
function audit(label: string, data: AppDataV2, pick: (t: Transaction) => boolean, mutate: (d: AppDataV2) => AppDataV2) {
  const before = data.transactions.filter(pick)
  const after = autoClearDuePayments(mutate(data), asOf).transactions.filter(pick)
  const added = after.filter((a) => !before.some((b) => b.id === a.id)).map((a) => `${a.date}:${a.status}`)
  const removed = before.filter((b) => !after.some((a) => a.id === b.id)).map((a) => a.date)
  const moved = after.filter((a) => before.some((b) => b.id === a.id && b.date !== a.date)).map((a) => `${before.find(b=>b.id===a.id)!.date}→${a.date}`)
  console.log(`${added.length ? 'DUP?' : 'ok  '} ${label}: rows ${before.length}→${after.length} added[${added}] removed[${removed}] moved[${moved}] before[${before.map(b=>b.date)}]`)
}
// T1 single occurrence date move of a materialised (cleared) bill occurrence, via Manage upcoming (originalDate key)
const agria = mum.recurringTemplates.find((t) => t.name === 'Agria Pet Insurance - Pippa')!
audit('template single move (manage upcoming) 15→17 Sep', mum, (t) => t.sourceId === agria.id, (d) => ({ ...d, recurringTemplates: d.recurringTemplates.map((t) => t.id === agria.id ? { ...t, ...applyTemplateSingleOccurrenceDateChange(t, '2026-09-17', '2026-09-15') } : t) }))
audit('template single move twice 15→17→13', mum, (t) => t.sourceId === agria.id, (d) => {
  const once = autoClearDuePayments({ ...d, recurringTemplates: d.recurringTemplates.map((t) => t.id === agria.id ? { ...t, ...applyTemplateSingleOccurrenceDateChange(t, '2026-09-17', '2026-09-15') } : t) }, asOf)
  return { ...once, recurringTemplates: once.recurringTemplates.map((t) => t.id === agria.id ? { ...t, ...applyTemplateSingleOccurrenceDateChange(t, '2026-09-13', '2026-09-15') } : t) }
})
// T1b: weekly shopping has amount overrides with date; single-date move of 12 Sep to 14 Sep
const ws = mum.recurringTemplates.find((t) => t.name === 'Weekly shopping')!
audit('recurring txn single move 12→14 Sep', mum, (t) => t.sourceId === ws.id, (d) => ({ ...d, recurringTemplates: d.recurringTemplates.map((t) => t.id === ws.id ? { ...t, ...applyTemplateSingleOccurrenceDateChange(t, '2026-09-14', '2026-09-12') } : t) }))
// Loans: startDate change
for (const loan of mum.loans) {
  const day = Number(loan.startDate.slice(8)); const nd = String(day >= 27 ? day - 2 : day + 2).padStart(2, '0')
  audit(`loan startDate ${loan.name} ${loan.startDate}→day ${nd}`, mum, (t) => t.sourceId === loan.id, (d) => ({ ...d, loans: d.loans.map((l) => l.id === loan.id ? { ...l, startDate: l.startDate.slice(0, 8) + nd } : l) }))
}
for (const loan of adam.loans) {
  console.log('adam loan', loan.name, loan.startDate, JSON.stringify(loan.recurringOverpayment))
  const day = Number(loan.startDate.slice(8)); const nd = String(day >= 27 ? day - 2 : day + 2).padStart(2, '0')
  audit(`loan startDate ${loan.name}`, adam, (t) => t.sourceId === loan.id, (d) => ({ ...d, loans: d.loans.map((l) => l.id === loan.id ? { ...l, startDate: l.startDate.slice(0, 8) + nd } : l) }))
  if (loan.recurringOverpayment) {
    const sd = loan.recurringOverpayment.startDate; const od = Number(sd.slice(8)); const ond = String(od >= 27 ? od - 2 : od + 2).padStart(2, '0')
    audit(`recurring overpayment startDate ${loan.name} ${sd}→${ond}`, adam, (t) => t.sourceId === loan.id && t.sourceType === 'loan_recurring_overpayment', (d) => ({ ...d, loans: d.loans.map((l) => l.id === loan.id ? { ...l, recurringOverpayment: { ...l.recurringOverpayment!, startDate: sd.slice(0, 8) + ond } } : l) }))
  }
}
// Cards: payment day change
for (const c of mum.creditCards) {
  const nd = c.paymentDayOfMonth >= 27 ? c.paymentDayOfMonth - 2 : c.paymentDayOfMonth + 2
  audit(`card payment day ${c.name} ${c.paymentDayOfMonth}→${nd}`, mum, (t) => t.creditCardId === c.id && t.type === 'credit_card_payment', (d) => ({ ...d, creditCards: d.creditCards.map((x) => x.id === c.id ? { ...x, paymentDayOfMonth: nd } : x) }))
}
// Salary payday change
for (const pc of adam.payCycles) {
  const nd = pc.paydayDayOfMonth >= 27 ? pc.paydayDayOfMonth - 2 : pc.paydayDayOfMonth + 2
  audit(`salary payday ${pc.personId} ${pc.paydayDayOfMonth}→${nd}`, adam, (t) => t.type === 'salary' && t.personId === pc.personId, (d) => ({ ...d, payCycles: d.payCycles.map((x) => x.personId === pc.personId ? { ...x, paydayDayOfMonth: nd } : x) }))
}
// Pension anchor change (synthetic)
const person = mum.people[0]
const withPension: AppDataV2 = autoClearDuePayments({ ...mum, pensions: [{ id: 'pen', personId: person.id, name: 'State', amount: 500, frequency: 'monthly', anchorDate: '2026-08-25', active: true, adjustForNonWorkingDay: false, cycleStartFollowsPayday: false }] }, asOf)
audit('pension anchor 25→27', withPension, (t) => t.sourceId === 'pen', (d) => ({ ...d, pensions: d.pensions.map((p) => ({ ...p, anchorDate: '2026-08-27' })) }))
audit('pension freq monthly→weekly', withPension, (t) => t.sourceId === 'pen', (d) => ({ ...d, pensions: d.pensions.map((p) => ({ ...p, frequency: 'weekly' as const })) }))
// Savings interest frequency (Adam's savings pot)
for (const s of adam.savingsPots) {
  console.log('savings pot', s.name, JSON.stringify(s.interestMethod), s.openingDate)
}
