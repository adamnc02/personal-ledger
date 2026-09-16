import { defaultLedgerData, defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import { generateTransactionsForTemplate, scheduledTemplateDates } from '../src/lib/schedule'
import { generatePensionTransactions } from '../src/lib/pensionLedger'
import { generateLoanPaymentTransactions } from '../src/lib/ledgerLoans'
import { generateMinimumPaymentTransactions } from '../src/lib/creditCards'
import { upcomingPaydays } from '../src/lib/salaryLedger'
const s = new Date(2027, 0, 1), e = new Date(2027, 5, 30)
const b = defaultLedgerData(); const me = b.primaryPersonId
const show = (label: string, dates: string[]) => console.log(label.padEnd(26), dates.join(' '))
const tpl: any = { id: 't', name: 't', amount: 10, categoryId: 'c', paymentMethod: 'card', frequency: 'monthly', anchorDate: '2026-12-31', location: 'personal', ownerId: me, payee: '', payeeSharePercent: 100, active: true }
show('bill generator', generateTransactionsForTemplate(tpl, s, e).map((t) => t.date))
show('bill manage-upcoming', scheduledTemplateDates(tpl, s, e).map((t) => t.date))
show('bill quarterly 31 Aug', generateTransactionsForTemplate({ ...tpl, frequency: 'quarterly', anchorDate: '2026-08-31' }, s, new Date(2027, 11, 31)).map((t) => t.date))
show('bill annual 29 Feb 2028', generateTransactionsForTemplate({ ...tpl, frequency: 'annual', anchorDate: '2028-02-29' }, new Date(2028,0,1), new Date(2031, 11, 31)).map((t) => t.date))
show('pension', generatePensionTransactions({ id: 'p', personId: me, name: 'p', amount: 1, frequency: 'monthly', anchorDate: '2026-12-31', active: true, adjustForNonWorkingDay: false, cycleStartFollowsPayday: false } as any, s, e).map((t) => t.date))
show('loan', generateLoanPaymentTransactions({ id: 'l', name: 'l', monthlyPayment: 100, termMonths: 24, startDate: '2026-12-31', principal: 2000, categoryId: 'c', location: 'personal', ownerId: me, payee: '', payeeSharePercent: 100, overpayments: [], active: true } as any, s, e).filter(t=>t.sourceType==='loan').map((t) => t.date))
show('loan overpayment', generateLoanPaymentTransactions({ id: 'l', name: 'l', monthlyPayment: 100, termMonths: 24, startDate: '2026-12-15', principal: 2000, categoryId: 'c', location: 'personal', ownerId: me, payee: '', payeeSharePercent: 100, overpayments: [], active: true, recurringOverpayment: { startDate: '2026-12-31', amount: { type: 'fixed', amount: 5 } } } as any, s, e).filter(t=>t.sourceType==='loan_recurring_overpayment').map((t) => t.date))
show('credit card min', generateMinimumPaymentTransactions({ id: 'c', name: 'c', categoryId: 'c', color: '', interestRatePercent: 0, currentBalance: 1000, balanceAsOfDate: '2026-12-01', minimumPayment: { type: 'fixed', amount: 25 }, paymentDayOfMonth: 31, ownerId: me, lumpPayments: [], active: true } as any, s, e, []).map((t) => t.date))
show('salary paydays (no adjust)', upcomingPaydays({ ...defaultPayCycleConfig(me), paydayDayOfMonth: 31, paydayAdjustForNonWorkingDay: false } as any, s, 6).map((d: Date) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')))
