// Proves the loan capital + card balance figures do NOT depend on
// projection.ts's opening-balance floor, so removing the floor exemption
// cannot alter them.
import { readFileSync } from 'node:fs'
import { summarizeLoanProgress } from '../src/lib/ledgerLoans'
import { cardBalanceAsOf } from '../src/lib/creditCards'
import type { AppDataV2, Loan } from '../src/types/ledger'

// Reads a real backup so the fixtures are authoritative app state rather
// than a hand-built approximation. Defaults to the committed copy under
// scripts/fixtures; point LEDGER_BACKUP at a fresher export to re-run
// these checks against current data.
const BACKUP = process.env.LEDGER_BACKUP ?? new URL('./fixtures/backup-2026-08-24.json', import.meta.url).pathname
const data = JSON.parse(readFileSync(BACKUP, 'utf8')) as AppDataV2
const today = new Date(2026, 7, 24)
const hi = data.loans.find(l => l.name === 'Home Improvements')!

const before = summarizeLoanProgress(hi, today)
const withOp: Loan = { ...hi, overpayments: [{ id:'op1', date:'2025-02-22', amount:40, recastMode:'reduce_term' }] }
const after = summarizeLoanProgress(withOp, today)

console.log('Home Improvements capitalRemaining without overpayment:', before.capitalRemaining)
console.log('Home Improvements capitalRemaining WITH  overpayment  :', after.capitalRemaining)
console.log('=> loan capital reacts to loan.overpayments directly  :', before.capitalRemaining !== after.capitalRemaining)

const card = data.creditCards.find(c => c.name === 'Santander')!
console.log('\nSantander balance (anchored on card.balanceAsOfDate)  :', cardBalanceAsOf(card, data.transactions, today))
console.log('=> card balance never consults payCycle.openingBalanceDate')
