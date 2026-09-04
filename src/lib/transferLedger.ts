// ── Transfer — the generic replacement for Savings/Joint/Pots' own
// deposit/withdrawal pills (2026-09-04 session, App_Dev.md "Salary
// Sorter & Transfer Pill"). A single Transaction/RecurringTemplate shape
// (type/kind: 'transfer', TransferLocation endpoints — see
// types/ledger.ts) now covers every combination of current account /
// savings pot / joint account / pot, one-off or recurring.
//
// The "current account" endpoint is ALWAYS the primary person (Adam-
// specified 2026-09-04: "always assume current account is me, no option
// to change") — this is what lets every transfer flow through the
// EXISTING personal-ledger machinery (projection.ts/autoClear.ts/
// runningBalance.ts) unchanged: whenever 'personal' is one of the two
// endpoints, the transaction still carries `location: 'personal'`,
// `ownerId: <primary person>`, and a `direction` derived from which side
// personal is on — exactly the shape savings_deposit/joint_deposit/
// pot_deposit used to set by hand. `fromLocation`/`toLocation` are the
// new, explicit fields; `savingsPotId`/`potId` are ALSO still populated
// (whichever endpoint is a savings pot / pot) purely so every existing
// simple `t.savingsPotId === pot.id` / `t.potId === pot.id` filter
// elsewhere in the app keeps working unchanged.
//
// This file is the one place that knows how to read BOTH sides of a
// transfer — locationsEqual/matchesLocation for filtering, and a signed-
// amount function per non-personal ledger (savingsPotLedger.ts/
// jointAccountLedger.ts/potLedger.ts each import the relevant one rather
// than re-deriving the "which side am I, and is that an inflow or
// outflow" logic themselves).

import { nanoid } from 'nanoid'
import { SAVINGS_CATEGORY_ID } from '../types/ledger'
import { seededCategoryIdForIcon } from './categories'
import { toLocalIsoDate as toIso } from './date'
import type { Transaction, TransferLocation } from '../types/ledger'

// Same fixed bucket LedgerContext.tsx's superseded joint_deposit/
// joint_withdrawal used to create against — kept as the same constant
// (not re-exported from LedgerContext, to avoid a circular import; both
// sides independently derive the same deterministic id).
export const TRANSFER_JOINT_CATEGORY_ID = seededCategoryIdForIcon('joint')

/** True when two TransferLocations refer to the exact same place (same type, and same id when one is required). */
export function locationsEqual(a: TransferLocation | undefined, b: TransferLocation | undefined): boolean {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  if (a.type === 'savings') return a.savingsPotId === b.savingsPotId
  if (a.type === 'pot') return a.potId === b.potId
  return true // 'personal' and 'joint' need no id — there's only ever one of each
}

/** A short label for a TransferLocation, e.g. for the "Savings → Joint Account" row title. Needs the live entity lists to resolve a pot/savings pot's name. */
export function transferLocationLabel(
  location: TransferLocation | undefined,
  savingsPots: { id: string; name: string }[],
  pots: { id: string; name: string }[],
): string {
  if (!location) return 'Unknown'
  switch (location.type) {
    case 'personal':
      return 'Current Account'
    case 'joint':
      return 'Joint Account'
    case 'savings':
      return savingsPots.find((p) => p.id === location.savingsPotId)?.name ?? 'Savings'
    case 'pot':
      return pots.find((p) => p.id === location.potId)?.name ?? 'Pot'
  }
}

/**
 * Which built-in category a transfer's occurrences carry — reuses the
 * same seeded categories the superseded per-type deposit/withdrawal
 * transactions used to (Savings for savings/pot, Joint for joint),
 * rather than inventing a new one, so grouped-by-category views don't
 * gain a brand-new bucket for what's conceptually the same kind of
 * activity as before.
 */
export function categoryForTransfer(from: TransferLocation | undefined, to: TransferLocation | undefined): string {
  if (from?.type === 'joint' || to?.type === 'joint') return TRANSFER_JOINT_CATEGORY_ID
  return SAVINGS_CATEGORY_ID
}

/**
 * The signed effect a transfer transaction has on a SavingsPot's own
 * ledger — positive (inflow) if the pot is the destination, negative
 * (outflow) if it's the source, 0 if the pot isn't either endpoint at
 * all (shouldn't be called in that case, but kept total). Mirrors the
 * "type decides the sign on THIS ledger" pattern credit_card_spend/the
 * superseded savings_deposit already used, just resolved from
 * fromLocation/toLocation now that one type can mean either direction.
 */
export function savingsPotSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>, savingsPotId: string): number {
  if (t.type !== 'transfer') return 0
  if (t.toLocation?.type === 'savings' && t.toLocation.savingsPotId === savingsPotId) return t.amount
  if (t.fromLocation?.type === 'savings' && t.fromLocation.savingsPotId === savingsPotId) return -t.amount
  return 0
}

/** Same as savingsPotSignedAmount above, for a Pot. */
export function potTransferSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>, potId: string): number {
  if (t.type !== 'transfer') return 0
  if (t.toLocation?.type === 'pot' && t.toLocation.potId === potId) return t.amount
  if (t.fromLocation?.type === 'pot' && t.fromLocation.potId === potId) return -t.amount
  return 0
}

/** Same as savingsPotSignedAmount above, for the (singleton) joint account. */
export function jointTransferSignedAmount(t: Pick<Transaction, 'type' | 'amount' | 'fromLocation' | 'toLocation'>): number {
  if (t.type !== 'transfer') return 0
  if (t.toLocation?.type === 'joint') return t.amount
  if (t.fromLocation?.type === 'joint') return -t.amount
  return 0
}

/**
 * Builds a one-off transfer Transaction — the exact same shape
 * LedgerContext.logTransfer creates, pulled out as a pure function
 * (2026-09 Salary Sorter session) so both logTransfer AND
 * LedgerContext.saveSalarySort produce identical rows rather than two
 * hand-maintained copies of this logic drifting apart. `sourceType`/
 * `sourceId` are optional — omitted for an ordinary hand-logged/Transfer-
 * pill transfer, set to `'salary_sort'`/the owning SalarySort.id when
 * called from saveSalarySort (see SalarySort's own comment in
 * types/ledger.ts for what that link is for).
 */
export function buildTransferTransaction(
  from: TransferLocation,
  to: TransferLocation,
  amount: number,
  date: string,
  primaryPersonId: string,
  options?: { note?: string; followsPayday?: boolean; sourceType?: Transaction['sourceType']; sourceId?: string },
): Transaction {
  return {
    id: nanoid(8),
    date,
    amount,
    // Personal is always one of the two endpoints in practice (Adam-
    // specified 2026-09-04: "always assume current account is me, no
    // option to change") — 'out' when personal is the source, 'in' when
    // it's the destination. See logTransfer's own comment for the
    // (currently UI-unreachable) neither-endpoint-personal fallback.
    direction: from.type === 'personal' ? 'out' : 'in',
    categoryId: categoryForTransfer(from, to),
    paymentMethod: 'bank_transfer',
    status: date <= toIso(new Date()) ? 'cleared' : 'pending',
    type: 'transfer',
    location: from.type === 'personal' || to.type === 'personal' ? 'personal' : from.type === 'joint' || to.type === 'joint' ? 'joint' : 'pot',
    ownerId: primaryPersonId,
    savingsPotId: from.type === 'savings' ? from.savingsPotId : to.type === 'savings' ? to.savingsPotId : undefined,
    potId: from.type === 'pot' ? from.potId : to.type === 'pot' ? to.potId : undefined,
    fromLocation: from,
    toLocation: to,
    followsPayday: options?.followsPayday,
    sourceType: options?.sourceType,
    sourceId: options?.sourceId,
    note: options?.note,
  }
}

/** True if a transfer has the given pot as either endpoint. Pass fromLocation/toLocation (a Transaction) or transferFrom/transferTo (a RecurringTemplate) directly. */
export function transferTouchesPot(from: TransferLocation | undefined, to: TransferLocation | undefined, potId: string): boolean {
  return (from?.type === 'pot' && from.potId === potId) || (to?.type === 'pot' && to.potId === potId)
}

/** Same as transferTouchesPot above, for a savings pot. */
export function transferTouchesSavingsPot(from: TransferLocation | undefined, to: TransferLocation | undefined, savingsPotId: string): boolean {
  return (from?.type === 'savings' && from.savingsPotId === savingsPotId) || (to?.type === 'savings' && to.savingsPotId === savingsPotId)
}

/** Same as transferTouchesPot above, for the (singleton) joint account. */
export function transferTouchesJoint(from: TransferLocation | undefined, to: TransferLocation | undefined): boolean {
  return from?.type === 'joint' || to?.type === 'joint'
}
