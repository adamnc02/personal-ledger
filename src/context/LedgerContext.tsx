import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { nanoid } from 'nanoid'
import type {
  AppDataV2,
  Category,
  CreditCard,
  Loan,
  PayCycleConfig,
  PaymentMethod,
  Pension,
  Person,
  Pot,
  RecurringTemplate,
  SalaryOverride,
  SalarySnapshot,
  SalarySort,
  SalarySortTarget,
  SavingsPot,
  StatementCalibrationLine,
  Transaction,
  TransferLocation,
} from '../types/ledger'
import type { BillLocation } from '../types/models'
import { categoryForTransfer, buildTransferTransaction, locationsEqual, locationTypeForTransfer, transferLocationLabel } from '../lib/transferLedger'
import { reassignTransactionsForLocationChange, priorLocationEntry } from '../lib/locationChange'

import type { Scenario } from '../types/models'
import { defaultLedgerData, defaultPayCycleConfig, loadLedgerData, saveLedgerData } from '../lib/ledgerStorage'
import { createCategory, removeCategorySafely } from '../lib/categories'
import { recordCreditCardSpend, recordCreditCardLumpPayment } from '../lib/creditCards'
import { applyLoanOverpayment, settleLoan, calibrateLoanFromStatementLines, type CalibrationResult } from '../lib/ledgerLoans'
import { autoClearDuePayments } from '../lib/autoClear'
import { reconcilePersonReferences } from '../lib/household'
import { convertClearedSalaryToStandaloneIncome } from '../lib/salaryLedger'

import { toLocalIsoDate as toIso } from '../lib/date'
const todayIso = () => toIso(new Date())

// ── Pending-transaction sweep on delete (UI consistency review §3/§10
// Phase 1, confirmed 2026-09 session: "all pending transactions are
// deleted, with only cleared items retained as historic fact, and
// immutable" — refined by UAT Batch 4, see isSweepableOnGeneratorDelete
// below: a cleared item dated TODAY is the one exception) ─────────────
// Deleting a Loan/CreditCard/RecurringTemplate/Pension/SavingsPot never
// touched `transactions` at all before this — a CLEARED row correctly
// stayed untouched (it already happened, deleting its generator doesn't
// un-happen it), but a PENDING one silently stuck around too: still
// shown as due, permanently orphaned from a generator that no longer
// exists. This removes the pending ones, plus any cleared-today ones.
//
// Loans need their own matcher rather than reusing the generic one below
// — a loan's overpayments carry sourceId: <overpayment's own id>, not the
// loan's id, so a transaction can belong to a loan without sourceId
// equalling loan.id at all. Every OTHER loan-generated sourceType
// (loan/loan_recurring_overpayment/loan_settlement) does use loan.id
// directly — see ledgerLoans.ts's own transaction-building code for the
// convention this mirrors.
// UAT Batch 4 (2026-09-04, Adam-specified): a CLEARED transaction is
// normally immutable historic fact and survives every sweep below — but
// one dated TODAY is an exception, since "cleared" for a same-day item
// generally just means auto-clear already ran for it moments ago, not
// that it's settled history worth preserving. This is also the root fix
// for the stray-pot-balance bug (a recurring transfer's already-cleared
// TODAY occurrence surviving deletion of its generator). There's no
// creation-timestamp field anywhere on Transaction, so the transaction's
// own `date` is the only "today" signal available.
function isSweepableOnGeneratorDelete(t: Transaction, asOfIso: string): boolean {
  return t.status === 'pending' || t.date === asOfIso
}

export function sweepPendingForLoan(transactions: Transaction[], loan: Loan, asOfIso: string = todayIso()): Transaction[] {
  const overpaymentIds = new Set(loan.overpayments.map((o) => o.id))
  return transactions.filter((t) => {
    if (!isSweepableOnGeneratorDelete(t, asOfIso)) return true
    if (t.sourceType === 'loan' || t.sourceType === 'loan_recurring_overpayment' || t.sourceType === 'loan_settlement') return t.sourceId !== loan.id
    if (t.sourceType === 'loan_overpayment') return !overpaymentIds.has(t.sourceId ?? '')
    return true
  })
}

// CreditCard and SavingsPot both carry a direct FK field on Transaction
// (creditCardId/savingsPotId) covering every way a transaction can be
// tied to them — generated minimum payments (no sourceType at all),
// logged lump payments/deposits (sourceType set), and spend/withdrawals
// alike — so one plain filter on that field is correct and complete,
// unlike loans above.
export function sweepPendingForCreditCard(transactions: Transaction[], cardId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.creditCardId !== cardId)
}
export function sweepPendingForSavingsPot(transactions: Transaction[], potId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.savingsPotId !== potId)
}
// Pots backlog item (2026-09-03) — same "one direct FK field covers
// everything" reasoning as sweepPendingForSavingsPot/sweepPendingForCreditCard
// above: potId is stamped on pot_deposit/pot_withdrawal AND on any
// pot-funded bill_payment/loan_payment row (see RecurringTemplate.potId's
// comment), so one plain filter is correct and complete here too.
export function sweepPendingForPot(transactions: Transaction[], potId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.potId !== potId)
}
// RecurringTemplate and Pension only ever get linked via sourceType/
// sourceId (no direct FK field on Transaction the way cards/pots have).
export function sweepPendingForSource(transactions: Transaction[], sourceType: NonNullable<Transaction['sourceType']>, sourceId: string, asOfIso: string = todayIso()): Transaction[] {
  return transactions.filter((t) => !isSweepableOnGeneratorDelete(t, asOfIso) || t.sourceType !== sourceType || t.sourceId !== sourceId)
}

// ── Salary Sort target removal (2026-09 session) — shared by
// updateTransaction (date-edit detach), removeTransaction (delete), and
// LedgerContext's own clearSalarySortTarget/saveSalarySort below, so
// "drop one target, then remove the whole SalarySort if that empties it"
// is written exactly once. Pure — takes/returns the salarySorts array,
// no setDataState involved, so every caller composes it into their own
// single state update rather than this doing a second render pass.
export function dropSalarySortTarget(salarySorts: SalarySort[], sortId: string, transactionId: string): SalarySort[] {
  return salarySorts
    .map((s) => (s.id === sortId ? { ...s, targets: s.targets.filter((t) => t.transactionId !== transactionId) } : s))
    .filter((s) => s.targets.length > 0)
}

interface AdHocInput {
  type: 'expense' | 'income'
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

  /** Plain ad-hoc expense/income — never touches a credit card. Status defaults to 'cleared' if dated today or earlier, 'pending' if dated in the future. A bonus is NOT logged this way — see addSalaryOverride, which folds it into the relevant pay period instead. */
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
  logLoanOverpayment: (loanId: string, amount: number, date: string, note?: string, recastMode?: 'reduce_term' | 'reduce_payment') => void
  /** Edits a logged loan overpayment's amount/date/note in place — updates both the LoanOverpayment record (which buildLoanSchedule reads fresh every call, so the schedule just reflects the new value automatically) and its matching transaction. No balance-reversal step needed here unlike credit cards: a loan's remaining balance is always derived from the schedule, never stored separately. */
  updateLoanOverpayment: (loanId: string, overpaymentId: string, amount: number, date: string, note?: string) => void
  /** Removes a logged loan overpayment entirely — the record AND its transaction. */
  removeLoanOverpayment: (loanId: string, overpaymentId: string) => void
  /** Logs the real, actual amount paid to close a loan early (scope §7) — inserts a cleared loan_payment transaction (sourceType 'loan_settlement') and marks the loan inactive with a closedDate, so it reports as fully repaid regardless of what its mechanical schedule would have predicted. */
  settleLoanAction: (loanId: string, actualAmountPaid: number, date: string, note?: string) => void
  /** Merges new statement lines into the loan's calibration, re-fits every known convention against the whole accumulated set, and persists the winning convention/rate (scope §5.3). Returns the confidence result so the calibration modal can show the right message without a second read. */
  calibrateLoanAction: (loanId: string, newLines: StatementCalibrationLine[]) => CalibrationResult | null

  addCreditCard: (card: Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>) => string
  updateCreditCard: (id: string, updates: Partial<Omit<CreditCard, 'id'>>) => void
  updateCreditCardMinimumCharge: (cardId: string, date: string, amount: number) => void
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
  /**
   * Deletes a person's ENTIRE salary — every snapshot and override, not
   * just one (see removeSalarySnapshot for that). Distinct from the
   * end-date field (Wallet.tsx), which is non-destructive and preserves
   * history for a salary that's simply ending; this is the rarer,
   * deliberate "wipe it" action — e.g. correcting a mis-set-up salary, or
   * fully retiring someone whose income is now entirely pension-based.
   * Already-CLEARED 'salary' transactions are converted to standalone
   * 'income' ones first (see salaryLedger.ts's
   * convertClearedSalaryToStandaloneIncome for the full reasoning) so
   * deleting the record never ripples into already-happened history.
   */
  removeAllSalaryHistory: (personId: string) => void

  addSalaryOverride: (personId: string, override: Omit<SalaryOverride, 'id' | 'personId'>) => string
  updateSalaryOverride: (personId: string, overrideId: string, updates: Partial<Omit<SalaryOverride, 'id' | 'personId'>>) => void
  removeSalaryOverride: (personId: string, overrideId: string) => void

  // Savings pots — a concurrent, explicitly-OWNED entity (personId), same
  // architecture as Pension immediately below (backlog item a). Rate
  // changes go through updateSavingsPot with a patch computed by
  // savingsPotLedger.ts's applyInterestMethodChange, same convention as
  // Pension's amount changes.
  addSavingsPot: (personId: string, pot: Omit<SavingsPot, 'id' | 'personId'>) => string
  updateSavingsPot: (id: string, updates: Partial<Omit<SavingsPot, 'id' | 'personId'>>) => void
  removeSavingsPot: (id: string) => void
  // Hand-logged from the Transactions page's Savings button — two-sided
  // bookkeeping, same shape as recordCreditCardSpend/logCreditCardSpend:
  // one call materializes both the personal-ledger effect and the pot's
  // own ledger row as a single Transaction (savingsPotId + the right
  // type/direction), not two separate writes.
  logSavingsDeposit: (potId: string, amount: number, date: string, note?: string) => void
  logSavingsWithdrawal: (potId: string, amount: number, date: string, note?: string) => void
  // The info-icon ledger modal's "tap a row to adjust" — interest only
  // (see SavingsPotScheduleRow.overridable). Writes/updates a real
  // 'savings_interest' Transaction for that date so it round-trips like
  // any other cleared/pending row, same pattern as
  // updateCreditCardMinimumCharge below.
  overrideSavingsInterest: (potId: string, date: string, amount: number) => void

  // ── Transfer (2026-09-04 session, App_Dev.md "Salary Sorter & Transfer
  // Pill") — the ONE mechanism every one-off deposit/withdrawal against
  // Savings/Joint/Pots now goes through, whether logged from the
  // Transactions page's Transfer pill or from the entity's own card on
  // the Wallet page ("single clean consistent method to create them
  // throughout", Adam-specified 2026-09-04). logSavingsDeposit/
  // logJointDeposit/logPotDeposit (and their withdrawal counterparts)
  // below are now thin wrappers over this, kept only so every existing
  // call site (Wallet page cards, tests) keeps compiling with the exact
  // same signature it always had — see each one's own comment.
  /**
   * Returns the created Transaction's id (2026-09 Salary Sorter session —
   * previously void). Every existing call site ignored the return value
   * already, so this is source-compatible; saveSalarySort below is the
   * first caller that actually needs it, to store the traceable
   * transactionId link back onto each SalarySortTarget.
   */
  logTransfer: (from: TransferLocation, to: TransferLocation, amount: number, date: string, note?: string, followsPayday?: boolean) => string
  addRecurringTransfer: (template: Omit<RecurringTemplate, 'id' | 'active' | 'kind' | 'categoryId' | 'paymentMethod' | 'location' | 'ownerId' | 'payee' | 'payeeSharePercent'>) => string

  // ── Salary Sort (App_Dev.md "Salary Sorter & Transfer Pill", 2026-09
  // session) — see SalarySort's own comment in types/ledger.ts for the
  // full two-way-sync contract these implement. ─────────────────────
  /**
   * Upserts the SalarySort for `payDate` against the given target list —
   * diffs against whatever's already saved (if anything) and creates/
   * updates/removes the matching transfer Transactions accordingly. A
   * target with `amount <= 0` is treated as "don't create/keep this
   * transfer" (Adam's explicit "0 is null" call) — same effect as
   * omitting it entirely or pressing its own Clear button. If every
   * target ends up dropped, the SalarySort record itself is removed
   * rather than left empty.
   */
  saveSalarySort: (payDate: string, targets: { to: TransferLocation; amount: number }[]) => void
  /** One location's own Clear button on an ALREADY-SAVED sort — removes just that target and its transaction, leaving the rest of the sort intact. A no-op if this payDate/location was never saved (the modal's own Clear button on an unsaved draft just nulls the input locally, nothing to call here for that case). */
  clearSalarySortTarget: (payDate: string, location: TransferLocation) => void
  /** The whole-sort Clear button — removes every target's transaction and the SalarySort record itself. */
  clearSalarySort: (payDate: string) => void

  // Pensions — a concurrent, explicitly-OWNED income source (personId),
  // not nested under Person the way salary is. See Pension's own comment
  // in types/ledger.ts for why. Single generic update action, same
  // convention as updateRecurringTemplate — the UI computes the patch
  // (via pensionLedger.ts's applyPensionAmountChange for a standing
  // change, or a direct occurrenceOverrides patch for a single-row edit)
  // before calling this, rather than this action knowing about either.
  addPension: (personId: string, pension: Omit<Pension, 'id' | 'personId'>) => string
  updatePension: (id: string, updates: Partial<Omit<Pension, 'id' | 'personId'>>) => void
  removePension: (id: string) => void

  // What-if scenarios — data storage only. See lib/legacyBridge.ts for
  // how the scenario ENGINE itself gets fed real ledger data.
  addScenario: (scenario: Omit<Scenario, 'id'>) => string
  updateScenario: (id: string, updates: Partial<Omit<Scenario, 'id'>>) => void
  removeScenario: (id: string) => void

  // ── Joint account (Adam-specified, 2026-09-03) ─────────────────────
  // Upserts AppDataV2.jointAccount — used both by the non-dismissable
  // first-time setup flow (JointAccountSetupModal) and by the Wallet
  // page's own "edit" affordance once it exists.
  setJointAccountOpening: (openingBalance: number, openingBalanceDate: string) => void
  // Hand-logged from the Transactions page's "Joint" pill — two-sided
  // bookkeeping, same shape as logSavingsDeposit/logSavingsWithdrawal:
  // one call materializes the real Transaction that both the depositing
  // person's own personal ledger AND the joint account's own ledger read
  // (see types/ledger.ts's joint_deposit/joint_withdrawal comments for
  // how the sign works on each side).
  logJointDeposit: (personId: string, amount: number, date: string, note?: string) => void
  logJointWithdrawal: (personId: string, amount: number, date: string, note?: string) => void

  // ── Pots (App Dev.md "Pots" backlog item, Adam-specified 2026-09-03) ──
  // Same top-level, personId-owned architecture as SavingsPot/Pension
  // immediately above — see Pot's own comment in types/ledger.ts for why
  // it's a separate entity rather than an extension of SavingsPot.
  addPot: (personId: string, pot: Omit<Pot, 'id' | 'personId'>) => string
  updatePot: (id: string, updates: Partial<Omit<Pot, 'id' | 'personId'>>) => void
  removePot: (id: string) => void
  // Hand-logged from the Transactions page's Pots button — same two-sided
  // bookkeeping shape as logSavingsDeposit/logSavingsWithdrawal above.
  logPotDeposit: (potId: string, amount: number, date: string, note?: string) => void
  logPotWithdrawal: (potId: string, amount: number, date: string, note?: string) => void
  // Moves a bill's REGULAR payment to/from a Pot (or personal/joint) —
  // the Wallet/Bills-page action behind the new location picker.
  // Retroactively rewrites every already-existing Transaction for this
  // template dated on/after `effectiveFrom` (cleared ones included, per
  // Adam's own spec), via lib/locationChange.ts, THEN updates the
  // template's own location/potId/locationHistory so every future
  // occurrence generates against the new location directly. `payee`/
  // `payeeSharePercent` are only meaningful when moving TO 'joint' — the
  // caller supplies whatever LocationEditor/the picker-first flow
  // resolved (same fields updateRecurringTemplate would otherwise take).
  assignRecurringTemplateLocation: (
    templateId: string,
    location: BillLocation,
    effectiveFrom: string,
    options?: { potId?: string; ownerId?: string; payee?: string; payeeSharePercent?: number },
  ) => void
  // Same action, for a Loan's own regular monthlyPayment — deliberately
  // NEVER touches the loan's recurringOverpayment/overpayments/
  // settlement, which have their own, independent location handling (see
  // LoanRecurringOverpayment.location's comment, and
  // lib/ledgerLoans.ts's resolveRecurringOverpaymentSource).
  assignLoanLocation: (
    loanId: string,
    location: BillLocation,
    effectiveFrom: string,
    options?: { potId?: string; ownerId?: string; payee?: string; payeeSharePercent?: number },
  ) => void
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
      personId: input.type === 'income' ? input.personId : undefined,
      note: input.note,
    }
    setDataState((prev) => ({ ...prev, transactions: [...prev.transactions, transaction] }))
  }

  // Salary Sort two-way sync (2026-09 session — see SalarySort's own
  // comment in types/ledger.ts for the full contract this implements):
  //  - Editing AMOUNT on a salary-sort-linked transaction also patches
  //    that target's own amount on the owning SalarySort.
  //  - Editing DATE detaches it — the transaction keeps existing as an
  //    ordinary transfer (sourceType/sourceId cleared), and its target is
  //    dropped from the SalarySort (a transfer no longer dated to this
  //    payday isn't part of "this payday's sort" any more). If that
  //    empties the SalarySort, the record itself is removed too, same
  //    "an empty sort isn't a sort" rule removeTransaction below follows.
  const updateTransaction: LedgerContextValue['updateTransaction'] = (id, updates) => {
    setDataState((prev) => {
      const existing = prev.transactions.find((t) => t.id === id)
      const transactions = prev.transactions.map((t) => (t.id === id ? { ...t, ...updates } : t))

      if (!existing || existing.sourceType !== 'salary_sort' || !existing.sourceId) {
        return { ...prev, transactions }
      }

      const dateChanged = updates.date !== undefined && updates.date !== existing.date
      if (dateChanged) {
        const detached = transactions.map((t) => (t.id === id ? { ...t, sourceType: undefined, sourceId: undefined } : t))
        return {
          ...prev,
          transactions: detached,
          salarySorts: dropSalarySortTarget(prev.salarySorts, existing.sourceId, id),
        }
      }

      if (updates.amount !== undefined && updates.amount !== existing.amount) {
        return {
          ...prev,
          transactions,
          salarySorts: prev.salarySorts.map((s) =>
            s.id === existing.sourceId ? { ...s, targets: s.targets.map((tgt) => (tgt.transactionId === id ? { ...tgt, amount: updates.amount! } : tgt)) } : s,
          ),
        }
      }

      return { ...prev, transactions }
    })
  }

  const removeTransaction: LedgerContextValue['removeTransaction'] = (id) => {
    setDataState((prev) => {
      const existing = prev.transactions.find((t) => t.id === id)
      const transactions = prev.transactions.filter((t) => t.id !== id)
      if (!existing || existing.sourceType !== 'salary_sort' || !existing.sourceId) {
        return { ...prev, transactions }
      }
      // Drops just this one target, leaving the rest of the sort intact
      // — matches saveSalarySort/clearSalarySortTarget's own "an empty
      // sort isn't a sort" rule if this was the last target.
      return { ...prev, transactions, salarySorts: dropSalarySortTarget(prev.salarySorts, existing.sourceId, id) }
    })
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
      // No balance adjustment step. The card's balance is derived from
      // its transactions (cardBalanceAsOf), so inserting the transaction
      // IS the balance change — and because it's derived, a same-day
      // payment shows immediately without needing to be nudged, while a
      // future-dated one correctly doesn't count until its date arrives.
      return {
        ...prev,
        creditCards: prev.creditCards.map((c) => (c.id === cardId ? updatedCard : c)),
        transactions: [...prev.transactions, { ...transaction, id: nanoid(8) }],
      }
    })
  }

  const removeCreditCardLumpPayment: LedgerContextValue['removeCreditCardLumpPayment'] = (cardId, lumpPaymentId) => {
    setDataState((prev) => {
      const card = prev.creditCards.find((c) => c.id === cardId)
      if (!card) return prev
      const transaction = prev.transactions.find((t) => t.sourceType === 'credit_card_lump_payment' && t.sourceId === lumpPaymentId)

      // No balance reversal needed: removing the transaction below is
      // itself the reversal, since the balance is derived from the
      // transaction list rather than stored as a running total.
      const updatedCard = { ...card, lumpPayments: card.lumpPayments.filter((lp) => lp.id !== lumpPaymentId) }

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

      // Reverse-then-relog: drop the old log record and its transaction,
      // then log the new values fresh through the exact same path a
      // brand-new payment goes through. The balance-reversal steps this
      // used to need are gone — swapping the transaction out for a new
      // one is the entire balance change, since the balance is derived.
      const workingCard: typeof card = { ...card, lumpPayments: card.lumpPayments.filter((lp) => lp.id !== lumpPaymentId) }
      let transactions = oldTransaction ? prev.transactions.filter((t) => t.id !== oldTransaction.id) : prev.transactions

      const { updatedCard, transaction: newTransaction } = recordCreditCardLumpPayment(workingCard, amount, date, note)
      transactions = [...transactions, { ...newTransaction, id: nanoid(8) }]

      return {
        ...prev,
        creditCards: prev.creditCards.map((c) => (c.id === cardId ? updatedCard : c)),
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
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === id)
      return {
        ...prev,
        loans: prev.loans.filter((l) => l.id !== id),
        transactions: loan ? sweepPendingForLoan(prev.transactions, loan) : prev.transactions,
      }
    })
  }
  const logLoanOverpayment: LedgerContextValue['logLoanOverpayment'] = (loanId, amount, date, note, recastMode) => {
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === loanId)
      if (!loan) return prev
      const { updatedLoan, transaction } = applyLoanOverpayment(loan, amount, date, note, recastMode)
      return {
        ...prev,
        loans: prev.loans.map((l) => (l.id === loanId ? updatedLoan : l)),
        transactions: [...prev.transactions, { ...transaction, id: nanoid(8) }],
      }
    })
  }

  const updateLoanOverpayment: LedgerContextValue['updateLoanOverpayment'] = (loanId, overpaymentId, amount, date, note) => {
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === loanId)
      if (!loan) return prev
      const updatedLoan = {
        ...loan,
        overpayments: loan.overpayments.map((o) => (o.id === overpaymentId ? { ...o, amount, date, note } : o)),
      }
      return {
        ...prev,
        loans: prev.loans.map((l) => (l.id === loanId ? updatedLoan : l)),
        transactions: prev.transactions.map((t) =>
          t.sourceType === 'loan_overpayment' && t.sourceId === overpaymentId ? { ...t, amount, date, note } : t,
        ),
      }
    })
  }

  const removeLoanOverpayment: LedgerContextValue['removeLoanOverpayment'] = (loanId, overpaymentId) => {
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === loanId)
      if (!loan) return prev
      const updatedLoan = { ...loan, overpayments: loan.overpayments.filter((o) => o.id !== overpaymentId) }
      return {
        ...prev,
        loans: prev.loans.map((l) => (l.id === loanId ? updatedLoan : l)),
        transactions: prev.transactions.filter((t) => !(t.sourceType === 'loan_overpayment' && t.sourceId === overpaymentId)),
      }
    })
  }

  const settleLoanAction: LedgerContextValue['settleLoanAction'] = (loanId, actualAmountPaid, date, note) => {
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === loanId)
      if (!loan) return prev
      const { updatedLoan, transaction } = settleLoan(loan, actualAmountPaid, date, note)
      return {
        ...prev,
        loans: prev.loans.map((l) => (l.id === loanId ? updatedLoan : l)),
        transactions: [...prev.transactions, { ...transaction, id: nanoid(8) }],
      }
    })
  }

  const calibrateLoanAction: LedgerContextValue['calibrateLoanAction'] = (loanId, newLines) => {
    const loan = data.loans.find((l) => l.id === loanId)
    if (!loan) return null
    const result = calibrateLoanFromStatementLines(loan, newLines)
    setDataState((prev) => ({ ...prev, loans: prev.loans.map((l) => (l.id === loanId ? result.updatedLoan : l)) }))
    return result
  }

  const addCreditCard: LedgerContextValue['addCreditCard'] = (card) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, creditCards: [...prev.creditCards, { ...card, id, lumpPayments: [], active: true }] }))
    return id
  }
  const updateCreditCard: LedgerContextValue['updateCreditCard'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, creditCards: prev.creditCards.map((c) => (c.id === id ? { ...c, ...updates } : c)) }))
  }
  // Credit card ledger modal's "tap a row to adjust" (Loans.tsx) — a date
  // that already exists as a real, stored transaction gets edited
  // directly (past or an already-materialized future one); a date that's
  // still only a generated projection gets an override recorded on the
  // card instead, which generateMinimumPaymentTransactions then picks up
  // on every future call. Both branches end up doing the right thing for
  // "past and future" without the caller needing to know which one applies.
  const updateCreditCardMinimumCharge: LedgerContextValue['updateCreditCardMinimumCharge'] = (cardId, date, amount) => {
    setDataState((prev) => {
      const card = prev.creditCards.find((c) => c.id === cardId)
      if (!card) return prev
      const existing = prev.transactions.find((t) => t.creditCardId === cardId && t.type === 'credit_card_payment' && t.date === date && !t.sourceType)
      if (existing) {
        return { ...prev, transactions: prev.transactions.map((t) => (t.id === existing.id ? { ...t, amount } : t)) }
      }
      const nextOverrides = [...(card.minimumPaymentOverrides ?? []).filter((o) => o.date !== date), { date, amount }]
      return { ...prev, creditCards: prev.creditCards.map((c) => (c.id === cardId ? { ...c, minimumPaymentOverrides: nextOverrides } : c)) }
    })
  }
  const removeCreditCard: LedgerContextValue['removeCreditCard'] = (id) => {
    setDataState((prev) => ({
      ...prev,
      creditCards: prev.creditCards.filter((c) => c.id !== id),
      transactions: sweepPendingForCreditCard(prev.transactions, id),
    }))
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
    setDataState((prev) => ({
      ...prev,
      recurringTemplates: prev.recurringTemplates.filter((t) => t.id !== id),
      transactions: sweepPendingForSource(prev.transactions, 'recurring_template', id),
    }))
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
      // Removing a person can orphan bills/loans/cards that reference
      // them (ownerId on personal items, payee on joint ones) and can
      // make an existing 'joint' item stop being meaningful if fewer
      // than 2 people are left — reconcilePersonReferences handles both,
      // and is also run on every load/restore so data already saved
      // before this existed self-heals too. See lib/household.ts.
      return reconcilePersonReferences({
        ...prev,
        people: remaining,
        payCycles: prev.payCycles.filter((pc) => pc.personId !== id),
      })
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
  const removeAllSalaryHistory: LedgerContextValue['removeAllSalaryHistory'] = (personId) => {
    setDataState((prev) => ({
      ...prev,
      transactions: convertClearedSalaryToStandaloneIncome(prev.transactions, personId),
      people: prev.people.map((p) => (p.id === personId ? { ...p, salaryHistory: [], salaryOverrides: [] } : p)),
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

  const addSavingsPot: LedgerContextValue['addSavingsPot'] = (personId, pot) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, savingsPots: [...prev.savingsPots, { ...pot, id, personId }] }))
    return id
  }
  const updateSavingsPot: LedgerContextValue['updateSavingsPot'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, savingsPots: prev.savingsPots.map((p) => (p.id === id ? { ...p, ...updates } : p)) }))
  }
  const removeSavingsPot: LedgerContextValue['removeSavingsPot'] = (id) => {
    setDataState((prev) => ({
      ...prev,
      savingsPots: prev.savingsPots.filter((p) => p.id !== id),
      // A pot's own CLEARED transactions (deposits/withdrawals/interest
      // already materialized) are historical fact and stay untouched —
      // same reasoning removePension uses for a person's past
      // pension_income transactions. PENDING ones are different: they
      // haven't happened yet and never will now, so they're swept
      // (2026-09 session — see sweepPendingForSavingsPot above).
      transactions: sweepPendingForSavingsPot(prev.transactions, id),
    }))
  }

  // ── Transfer (2026-09-04 session) — see LedgerContextValue.logTransfer's
  // own comment. The single mechanism creating a one-off transfer
  // Transaction; every legacy log*Deposit/Withdrawal function below is a
  // thin wrapper over this.
  // Builds via lib/transferLedger.ts's buildTransferTransaction (2026-09
  // Salary Sorter session — pulled out to a pure function so
  // saveSalarySort below produces byte-identical rows rather than a
  // second hand-maintained copy of this shape). See that function's own
  // comment for the "personal always one of the two endpoints" reasoning
  // and the neither-endpoint-personal fallback.
  const logTransfer: LedgerContextValue['logTransfer'] = (from, to, amount, date, note, followsPayday) => {
    const transaction = buildTransferTransaction(from, to, amount, date, data.primaryPersonId, { note, followsPayday })
    setDataState((prev) => ({ ...prev, transactions: [...prev.transactions, transaction] }))
    return transaction.id
  }

  const addRecurringTransfer: LedgerContextValue['addRecurringTransfer'] = (template) => {
    const id = nanoid(8)
    const full: RecurringTemplate = {
      ...template,
      id,
      active: true,
      kind: 'transfer',
      categoryId: categoryForTransfer(template.transferFrom, template.transferTo),
      paymentMethod: 'bank_transfer',
      // 'personal' whenever the primary person's own account is either
      // endpoint (the common case); 'joint' or 'pot' for a direct
      // Savings/Pot/Joint sweep with no personal leg at all — see
      // locationTypeForTransfer's own comment for why this can't just be
      // hardcoded 'personal' (autoClear.ts's dedicated non-personal
      // transfer materialization pass depends on this being correct).
      location: locationTypeForTransfer(template.transferFrom, template.transferTo),
      ownerId: data.primaryPersonId,
      payee: '',
      payeeSharePercent: 100,
    }
    setDataState((prev) => ({ ...prev, recurringTemplates: [...prev.recurringTemplates, full] }))
    return id
  }

  // ── Salary Sort (2026-09 session) — see SalarySort's own comment in
  // types/ledger.ts for the full two-way-sync contract. This is the ONE
  // place that diffs an incoming target list against whatever's already
  // saved and creates/updates/removes the matching transfer Transactions
  // in a single atomic state update — the sort modal (Salary page,
  // next-session UI work) is expected to call this once on Save with
  // its full current list, not call logTransfer/updateTransaction/
  // removeTransaction piecemeal itself. ──────────────────────────────
  const saveSalarySort: LedgerContextValue['saveSalarySort'] = (payDate, targets) => {
    setDataState((prev) => {
      const existingSort = prev.salarySorts.find((s) => s.payDate === payDate)
      const existingTargets = existingSort?.targets ?? []
      const keepTransactionIds = new Set<string>()
      const finalTargets: SalarySortTarget[] = []
      let transactions = prev.transactions

      for (const incoming of targets) {
        // Adam's explicit 2026-09 call: 0 (or negative) is treated as
        // "don't create/keep this transfer" — same as omitting the
        // target entirely or pressing its own Clear button. Handled by
        // simply never adding it to finalTargets/keepTransactionIds
        // below, so the "drop anything not kept" pass at the end
        // removes any existing transaction for it, same as an omission.
        if (incoming.amount <= 0) continue

        const existingTarget = existingTargets.find((t) => locationsEqual(t.to, incoming.to))
        if (existingTarget) {
          keepTransactionIds.add(existingTarget.transactionId)
          if (existingTarget.amount !== incoming.amount) {
            transactions = transactions.map((t) => (t.id === existingTarget.transactionId ? { ...t, amount: incoming.amount } : t))
          }
          finalTargets.push({ ...existingTarget, amount: incoming.amount })
        } else {
          const sortId = existingSort?.id ?? nanoid(8)
          const transaction = buildTransferTransaction({ type: 'personal' }, incoming.to, incoming.amount, payDate, prev.primaryPersonId, {
            note: `Salary Sort → ${transferLocationLabel(incoming.to, prev.savingsPots, prev.pots)}`,
            sourceType: 'salary_sort',
            sourceId: sortId,
          })
          transactions = [...transactions, transaction]
          keepTransactionIds.add(transaction.id)
          finalTargets.push({ id: nanoid(8), to: incoming.to, amount: incoming.amount, transactionId: transaction.id })
        }
      }

      // Anything that existed before but isn't in the kept set any more
      // (omitted, zeroed, or replaced) gets its transaction removed —
      // same "0/omitted means delete" rule as above.
      const droppedTransactionIds = existingTargets.filter((t) => !keepTransactionIds.has(t.transactionId)).map((t) => t.transactionId)
      if (droppedTransactionIds.length > 0) {
        transactions = transactions.filter((t) => !droppedTransactionIds.includes(t.id))
      }

      const otherSorts = prev.salarySorts.filter((s) => s.payDate !== payDate)
      // An empty result (every target omitted/zeroed) means no SalarySort
      // record at all for this payDate — an empty sort isn't a sort, per
      // dropSalarySortTarget's own rule elsewhere in this file.
      const salarySorts = finalTargets.length > 0 ? [...otherSorts, { id: existingSort?.id ?? nanoid(8), payDate, targets: finalTargets }] : otherSorts

      return { ...prev, transactions, salarySorts }
    })
  }

  const clearSalarySortTarget: LedgerContextValue['clearSalarySortTarget'] = (payDate, location) => {
    setDataState((prev) => {
      const sort = prev.salarySorts.find((s) => s.payDate === payDate)
      const target = sort?.targets.find((t) => locationsEqual(t.to, location))
      if (!sort || !target) return prev
      return {
        ...prev,
        transactions: prev.transactions.filter((t) => t.id !== target.transactionId),
        salarySorts: dropSalarySortTarget(prev.salarySorts, sort.id, target.transactionId),
      }
    })
  }

  const clearSalarySort: LedgerContextValue['clearSalarySort'] = (payDate) => {
    setDataState((prev) => {
      const sort = prev.salarySorts.find((s) => s.payDate === payDate)
      if (!sort) return prev
      const transactionIds = new Set(sort.targets.map((t) => t.transactionId))
      return {
        ...prev,
        transactions: prev.transactions.filter((t) => !transactionIds.has(t.id)),
        salarySorts: prev.salarySorts.filter((s) => s.id !== sort.id),
      }
    })
  }

  // SUPERSEDED (2026-09-04 session) — thin wrapper over logTransfer,
  // kept with its exact original signature so every existing call site
  // (Wallet page's Savings card) keeps compiling unchanged. New code
  // should call logTransfer directly with an explicit {type:'savings'}
  // destination instead.
  const logSavingsDeposit: LedgerContextValue['logSavingsDeposit'] = (potId, amount, date, note) => {
    const pot = data.savingsPots.find((p) => p.id === potId)
    if (!pot) return
    logTransfer({ type: 'personal' }, { type: 'savings', savingsPotId: potId }, amount, date, note || pot.name)
  }
  const logSavingsWithdrawal: LedgerContextValue['logSavingsWithdrawal'] = (potId, amount, date, note) => {
    const pot = data.savingsPots.find((p) => p.id === potId)
    if (!pot) return
    logTransfer({ type: 'savings', savingsPotId: potId }, { type: 'personal' }, amount, date, note || pot.name)
  }
  // Same "materialized real row wins, else write an override" shape as
  // updateCreditCardMinimumCharge above.
  const overrideSavingsInterest: LedgerContextValue['overrideSavingsInterest'] = (potId, date, amount) => {
    setDataState((prev) => {
      const pot = prev.savingsPots.find((p) => p.id === potId)
      if (!pot) return prev
      const existing = prev.transactions.find((t) => t.savingsPotId === potId && t.type === 'savings_interest' && t.date === date && !t.sourceType)
      if (existing) {
        return { ...prev, transactions: prev.transactions.map((t) => (t.id === existing.id ? { ...t, amount } : t)) }
      }
      const nextOverrides = [...(pot.interestOverrides ?? []).filter((o) => o.date !== date), { date, amount }]
      return { ...prev, savingsPots: prev.savingsPots.map((p) => (p.id === potId ? { ...p, interestOverrides: nextOverrides } : p)) }
    })
  }


  const addPension: LedgerContextValue['addPension'] = (personId, pension) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, pensions: [...prev.pensions, { ...pension, id, personId }] }))
    return id
  }
  const updatePension: LedgerContextValue['updatePension'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, pensions: prev.pensions.map((p) => (p.id === id ? { ...p, ...updates } : p)) }))
  }
  const removePension: LedgerContextValue['removePension'] = (id) => {
    setDataState((prev) => ({
      ...prev,
      pensions: prev.pensions.filter((p) => p.id !== id),
      transactions: sweepPendingForSource(prev.transactions, 'pension', id),
      // A person's followsIncomeSource pointing at a now-deleted pension
      // would silently strand their cycle-following choice — fall back
      // to 'salary' (the same default as never having set one), same
      // reconciliation instinct as household.ts's reconcilePersonReferences
      // for a dangling ownerId.
      payCycles: prev.payCycles.map((pc) =>
        pc.followsIncomeSource?.type === 'pension' && pc.followsIncomeSource.pensionId === id
          ? { ...pc, followsIncomeSource: { type: 'salary' } }
          : pc,
      ),
    }))
  }

  const setJointAccountOpening: LedgerContextValue['setJointAccountOpening'] = (openingBalance, openingBalanceDate) => {
    setDataState((prev) => ({ ...prev, jointAccount: { openingBalance, openingBalanceDate } }))
  }

  // SUPERSEDED (2026-09-04 session) — thin wrapper over logTransfer. The
  // `personId` parameter is now IGNORED (always resolves to the primary
  // person) — Adam-specified 2026-09-04: "current account leg... always
  // assume me, no option to change" — kept only so any surviving call
  // site with this exact signature still compiles; new code should call
  // logTransfer directly.
  const logJointDeposit: LedgerContextValue['logJointDeposit'] = (_personId, amount, date, note) => {
    logTransfer({ type: 'personal' }, { type: 'joint' }, amount, date, note || 'Joint account deposit')
  }
  const logJointWithdrawal: LedgerContextValue['logJointWithdrawal'] = (_personId, amount, date, note) => {
    logTransfer({ type: 'joint' }, { type: 'personal' }, amount, date, note || 'Joint account withdrawal')
  }

  // ── Pots (App Dev.md "Pots" backlog item, Adam-specified 2026-09-03) ──

  const addPot: LedgerContextValue['addPot'] = (personId, pot) => {
    const id = nanoid(8)
    setDataState((prev) => ({ ...prev, pots: [...prev.pots, { ...pot, id, personId }] }))
    return id
  }
  const updatePot: LedgerContextValue['updatePot'] = (id, updates) => {
    setDataState((prev) => ({ ...prev, pots: prev.pots.map((p) => (p.id === id ? { ...p, ...updates } : p)) }))
  }
  const removePot: LedgerContextValue['removePot'] = (id) => {
    setDataState((prev) => ({
      ...prev,
      pots: prev.pots.filter((p) => p.id !== id),
      // A pot's own CLEARED transactions (deposits/withdrawals, and any
      // pot-funded bill/loan payment that already happened) are
      // historical fact and stay untouched — same reasoning
      // removeSavingsPot uses. PENDING ones are swept — they haven't
      // happened and never will now.
      transactions: sweepPendingForPot(prev.transactions, id),
      // Any bill/loan whose REGULAR payment pointed at this now-deleted
      // pot falls back to 'personal' rather than being left with a
      // dangling potId that nothing generates against — same
      // reconciliation instinct as removePension's followsIncomeSource
      // fallback below, and household.ts's reconcilePersonReferences
      // backstop for the same case on data that predates this in-app
      // path. Recorded into locationHistory like any other location
      // change, so the Wallet page's audit trail shows WHY it moved.
      recurringTemplates: prev.recurringTemplates.map((t) =>
        t.location === 'pot' && t.potId === id
          ? {
              ...t,
              location: 'personal',
              potId: undefined,
              locationEffectiveFrom: todayIso(),
              locationHistory: [...(t.locationHistory ?? []), priorLocationEntry(t, t.anchorDate)],
            }
          : t,
      ),
      loans: prev.loans.map((l) => {
        let next = l
        if (l.location === 'pot' && l.potId === id) {
          next = {
            ...next,
            location: 'personal',
            potId: undefined,
            locationEffectiveFrom: todayIso(),
            locationHistory: [...(next.locationHistory ?? []), priorLocationEntry(next, next.startDate)],
          }
        }
        // A recurring overpayment independently funded from this pot
        // loses that explicit choice too — reverts to "follows the
        // loan's own location" (the field's own absent-default), not
        // forced to 'personal', since the loan itself might still be
        // pot-funded via a DIFFERENT pot, or genuinely personal/joint.
        if (next.recurringOverpayment?.location === 'pot' && next.recurringOverpayment.potId === id) {
          next = { ...next, recurringOverpayment: { ...next.recurringOverpayment, location: undefined, potId: undefined } }
        }
        return next
      }),
    }))
  }

  // SUPERSEDED (2026-09-04 session) — thin wrapper over logTransfer, same
  // reasoning as logSavingsDeposit/Withdrawal above.
  const logPotDeposit: LedgerContextValue['logPotDeposit'] = (potId, amount, date, note) => {
    const pot = data.pots.find((p) => p.id === potId)
    if (!pot) return
    logTransfer({ type: 'personal' }, { type: 'pot', potId }, amount, date, note || pot.name)
  }
  const logPotWithdrawal: LedgerContextValue['logPotWithdrawal'] = (potId, amount, date, note) => {
    const pot = data.pots.find((p) => p.id === potId)
    if (!pot) return
    logTransfer({ type: 'pot', potId }, { type: 'personal' }, amount, date, note || pot.name)
  }

  const assignRecurringTemplateLocation: LedgerContextValue['assignRecurringTemplateLocation'] = (templateId, location, effectiveFrom, options) => {
    setDataState((prev) => {
      const template = prev.recurringTemplates.find((t) => t.id === templateId)
      if (!template) return prev
      const updated: RecurringTemplate = {
        ...template,
        location,
        ownerId: options?.ownerId ?? template.ownerId,
        payee: location === 'joint' ? (options?.payee ?? template.payee) : template.payee,
        payeeSharePercent: location === 'joint' ? (options?.payeeSharePercent ?? template.payeeSharePercent) : template.payeeSharePercent,
        potId: location === 'pot' ? options?.potId : undefined,
        locationEffectiveFrom: effectiveFrom,
        locationHistory: [...(template.locationHistory ?? []), priorLocationEntry(template, template.anchorDate)],
      }
      return {
        ...prev,
        recurringTemplates: prev.recurringTemplates.map((t) => (t.id === templateId ? updated : t)),
        // The retroactive rewrite — see lib/locationChange.ts's file
        // header for why this isn't purely forward-looking. Scoped to
        // sourceType 'recurring_template' only, which is exactly this
        // bill's regular occurrences — nothing else carries that
        // sourceType against this id.
        transactions: reassignTransactionsForLocationChange(prev.transactions, 'recurring_template', templateId, effectiveFrom, location, options?.potId),
      }
    })
  }

  const assignLoanLocation: LedgerContextValue['assignLoanLocation'] = (loanId, location, effectiveFrom, options) => {
    setDataState((prev) => {
      const loan = prev.loans.find((l) => l.id === loanId)
      if (!loan) return prev
      const updated: Loan = {
        ...loan,
        location,
        ownerId: options?.ownerId ?? loan.ownerId,
        payee: location === 'joint' ? (options?.payee ?? loan.payee) : loan.payee,
        payeeSharePercent: location === 'joint' ? (options?.payeeSharePercent ?? loan.payeeSharePercent) : loan.payeeSharePercent,
        potId: location === 'pot' ? options?.potId : undefined,
        locationEffectiveFrom: effectiveFrom,
        locationHistory: [...(loan.locationHistory ?? []), priorLocationEntry(loan, loan.startDate)],
      }
      return {
        ...prev,
        loans: prev.loans.map((l) => (l.id === loanId ? updated : l)),
        // Scoped to sourceType 'loan' only — the regular scheduled
        // payment. Deliberately does NOT touch 'loan_recurring_overpayment'
        // / 'loan_overpayment' / 'loan_settlement' rows for this same
        // loan id, which have their own independent funding source (see
        // LedgerContextValue.assignLoanLocation's own comment).
        transactions: reassignTransactionsForLocationChange(prev.transactions, 'loan', loanId, effectiveFrom, location, options?.potId),
      }
    })
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
    updateLoanOverpayment,
    removeLoanOverpayment,
    settleLoanAction,
    calibrateLoanAction,
    addCreditCard,
    updateCreditCard,
    updateCreditCardMinimumCharge,
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
    removeAllSalaryHistory,
    addSalaryOverride,
    updateSalaryOverride,
    removeSalaryOverride,
    addSavingsPot,
    updateSavingsPot,
    removeSavingsPot,
    logSavingsDeposit,
    logSavingsWithdrawal,
    overrideSavingsInterest,
    logTransfer,
    addRecurringTransfer,
    saveSalarySort,
    clearSalarySortTarget,
    clearSalarySort,
    addPension,
    updatePension,
    removePension,
    addScenario,
    updateScenario,
    removeScenario,
    setJointAccountOpening,
    logJointDeposit,
    logJointWithdrawal,
    addPot,
    updatePot,
    removePot,
    logPotDeposit,
    logPotWithdrawal,
    assignRecurringTemplateLocation,
    assignLoanLocation,
  }

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>
}

export function useLedgerData(): LedgerContextValue {
  const ctx = useContext(LedgerContext)
  if (!ctx) throw new Error('useLedgerData must be used within a LedgerProvider')
  return ctx
}
