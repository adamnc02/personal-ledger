# personal-ledger UAT Bug Tracker

Living doc — updated after each turn with what's been done. Source: UAT round in
`personal-finance-ledger-bugs.md` (personal-ledger section) + reference screenshots.

Not in scope here: the three BLOC/personal-finance items (steps-box autofill, food modal
alignment, cycle-review dev work) — different app, code not yet in this session.

## Batch 1 — Copy, colour, pure layout (no logic changes) — ✅ DONE, awaiting your UAT
- [x] Clear this sort → red text (`--color-negative`) — `src/pages/Salary.tsx`
- [x] Salary Sorter pre-filled values: grey (`--color-ink-muted`) while unsaved, white
      (`--color-ink`) once actually saved to the sort — `src/pages/Salary.tsx`
- [x] Recurring transfer row label → `From location · type · To location` (was
      `template.name · type · otherLabel`, which duplicated the pot name on both sides) —
      `src/pages/Expenses.tsx`
- [x] Removed the "Savings" pill + branch from the Transactions → Recurring →
      "New recurring transaction" form (`RecurringTransactionForm`), and the now-unused
      `onSaveSavingsRecurring` plumbing from its parent. Pot recurring deposits are created
      from the Wallet page / Transfer page only now. The list of *already-configured* pot
      recurring deposits still shows below the form (unchanged) — only the creation entry
      point was removed. — `src/pages/Expenses.tsx`

Verified: `tsc -b` clean against baseline (only the 3 pre-existing, unrelated
`SavingsPotForm.test.tsx` missing-vitest-deps errors, confirmed present on the unedited repo
too). No `lib/` files touched, so the `verify-*.ts` suite is unaffected by this batch.

## Batch 2 — Modal/Cancel button consistency sweep — ✅ DONE, awaiting your UAT
- [x] Fix Cancel-button-invisible bug (container bg matches CancelButton bg) — Salary Sorter
      modal, Bills expanded form, and audit of other `--color-surface`-on-`--color-surface`
      containers — `src/components/FormButtons.tsx`, `src/pages/Salary.tsx`
- [x] Swap icon button between From/To on the transfer form — `src/pages/Expenses.tsx`
- [x] Transfer form "From" location made editable (currently locked to Current Account) —
      `src/pages/Expenses.tsx` + real engine fix, see notes below

## Batch 3 — Pot/location display bugs
- [ ] Pot creation gets a new/existing → opening balance/date step, matching Joint Account
      and Savings Pot flows (currently hardcoded to £0, which is the root cause of the
      "£100 total" bug — see below)
- [ ] "What this pot pays" header shows opening balance + net activity (Joint Account style),
      not raw balance
- [ ] "Joint" pill added to joint bills in the Bills list (alongside existing pot pill)
- [ ] Flatten Location + Pot into a single picker on Bills/Loans edit forms
- [ ] Recurring deposit step 2 card gets Save/Cancel and becomes collapsible
- [ ] Recurring deposit step 1 buttons → full-width pill style

## Batch 4 — Logic/data bugs (needs sign-off on exact rules before starting)
- [ ] Salary Sort → generate real Transfer-page transfers (not just ledger transactions);
      deleting a transfer zeroes its sort; clearing/deleting a sort deletes its transfers
- [ ] Pot recurring-deposit flow needs its own From-location picker (currently implies
      pot → pot, which is nonsensical)
- [ ] Joint bill shares should not appear in the Personal ledger at all; Joint ledger should
      show full bill amount, not the per-person share
- [ ] "Land on cycle period" option added alongside "follow payday"; checkboxes grey out
      day-of-month field when ticked; wording matched with Transfers page; row collapsible
- [ ] Deletion guard: transactions/bills/transfers created **today** hard-delete regardless
      of cleared status (this is also what fixes the stray pot balance bug above)

---

## Notes / decisions log

**2026-XX-XX — Pot £100 balance bug root-caused.** Pot creation hardcodes
`openingBalance: 0` with no UI to change it (unlike Joint Account / Savings Pot). The £100
came from a recurring transfer's already-cleared occurrences surviving deletion, per the
"cleared is immutable" rule — same mechanism Batch 4's deletion-guard item targets. Folded
into Batch 3 (opening balance UI) + Batch 4 (deletion guard).

**2026-09-04 — Batch 2, Cancel-button fix.** Root cause: `CancelButton`'s fixed
`--color-surface` background matched many of its own containers (Salary Sorter modal,
Pay Cycle Settings, Joint Account setup, Bills/Loans/Credit Card forms, Expenses forms,
and inline edit rows nested inside a `--color-surface` parent row) — 13 real invisible-
button instances found by auditing every `CancelButton`/`FormButtonRow` call site against
its actual container background. A straight background-color swap wasn't safe (roughly
half the app's forms use `--color-bg-elevated` containers instead, where the old
background was already correctly contrasting) — fixed instead with a `--color-track`
border, which reads against every background tone in the app regardless of context.

**2026-09-04 — Batch 2, Transfer "From" field.** Confirmed with Adam this meant real
Pot↔Pot/Pot↔Savings/Savings↔Joint transfers with no personal leg at all, not just
relabelling the existing Current-Account-fixed swap toggle — this reverses the
2026-09-04 "current account is always me, no exceptions" decision recorded earlier in
this doc for the SPECIFIC case of the personal leg no longer being mandatory (the
primary-person-only *destination* scoping — no picking a second person's own pot — is
unchanged). Doing this properly surfaced a real pre-existing engine gap, not just a UI
change: `Transaction.potId`/`savingsPotId` are single fields, so a transfer with the
SAME entity type on both ends (e.g. Pot A → Pot B) couldn't identify both sides at once
— the "losing" side's own stored-transaction lookups (`potLedger.ts`/
`savingsPotLedger.ts`) would never find their half of an already-materialized transfer.
Fixed by having those lookups resolve membership from `fromLocation`/`toLocation`
directly (already-correct for the *generated/preview* path — only the *materialized/
stored* path had the gap) rather than trusting the flat id field, and by fixing the
schedule-row modals' deposit-vs-withdrawal labelling, which had the identical
ambiguity. Recurring transfers with no personal leg also had no materialization path
into a real transaction at all (`addRecurringTransfer` hardcoded `location: 'personal'`
unconditionally, which — separately — would have wrongly leaked a Pot→Pot recurring
transfer into the *personal* ledger too) — fixed via a new shared
`locationTypeForTransfer` helper (`lib/transferLedger.ts`) plus a dedicated
autoClear.ts materialization pass scoped to exactly this case.
