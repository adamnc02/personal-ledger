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

## Batch 3 — Pot/location display bugs — ✅ DONE, awaiting your UAT
- [x] Pot creation gets a new/existing → opening balance/date step, matching Joint Account
      and Savings Pot flows (currently hardcoded to £0, which is the root cause of the
      "£100 total" bug — see below) — `src/pages/Salary.tsx` (`PotForm`)
- [x] Pot's Wallet-page row shows opening balance + net activity (Joint Account style),
      not raw balance — `src/pages/Salary.tsx` (`PotRow`)
- [x] "Joint" pill added to joint bills in the Bills list (alongside existing pot pill) —
      `src/pages/Bills.tsx`
- [x] Flatten Location + Pot into a single picker on Bills/Loans edit forms —
      `src/components/LocationEditor.tsx` (shared by both pages)
- [x] Recurring deposit step 2 card gets Save/Cancel and becomes collapsible —
      `src/pages/Salary.tsx` (`RecurringExistingDeposit`, split out of `RecurringTransferEditor`)
- [x] Recurring deposit step 1 buttons → full-width pill style — `src/pages/Salary.tsx`
      (`RecurringTransferEditor`, now uses the shared `FormButtonRow`)

Verified: `tsc -b` clean against baseline throughout. No `lib/` files touched — pure UI/
display plus one call-site fix (`PotForm` now passes a real `openingBalance`/`openingDate`
into the already-existing `newPot`), so full `verify-*.ts` suite re-run with no new
regressions (same two pre-existing gaps as every prior session: missing
`backup-2026-08-24.json` fixture, `verify-purchase-scenario.ts`'s three
`cycleStartFollowsPayday` failures). Also driven live in a headless-Chromium browser against
Adam's real fixture backup (`scripts/fixtures/backup-2026-09-02.json`) — created a real pot
with a £350 opening balance, confirmed the Wallet row's opening/net-activity breakdown,
added/edited/cancelled/saved a recurring deposit (collapse + draft-revert-on-Cancel all
confirmed), and set a bill to Joint via the flattened Bills-page picker, confirming both the
Joint pill and the first-time joint-account-setup prompt fire correctly.

### Batch 3 addendum — Wallet page UI consistency — ✅ DONE, awaiting your UAT
- [x] Pot's expanded edit form now matches Savings' own styling standard: fields on a
      darker `--color-bg-elevated` card, 2-column grid, Save/Cancel inside that card — the
      red inline text buttons (Log a deposit/withdrawal, recurring deposit, bills checklist)
      stay outside it, below — `src/pages/Salary.tsx` (`PotEditForm`, new)
- [x] Salary/Pensions/Savings/Pots sections default to collapsed when empty, instead of
      always expanded — `src/pages/Salary.tsx` (`defaultOpen` on each `CollapsibleSection`)
- [x] Primary person's row always sorted first in the Salary section's list (display-order
      only — `data.people`'s own underlying order is untouched everywhere else)
- [x] Salary sorter icon's visibility condition (savings pot OR pot OR joint account) —
      checked against real data live in the browser and confirmed it was already correct;
      no code change needed

Verified: `tsc -b` clean, full `verify-*.ts` suite re-run with no new regressions (same two
pre-existing gaps as always). Driven live in a headless-Chromium browser against Adam's real
fixture backup — confirmed the pot edit form's new styling, both sections' collapse-when-
empty behaviour, Adam's row sorting first ahead of Beverley's, and the sort icon correctly
showing on Adam's pay-period rows once a pot/joint account exist.

## Batch 4 — Logic/data bugs (needs sign-off on exact rules before starting)
- [x] Salary Sort → generate real Transfer-page transfers (not just ledger transactions);
      deleting a transfer zeroes its sort; clearing/deleting a sort deletes its transfers
- [ ] Pot recurring-deposit flow needs its own From-location picker (currently implies
      pot → pot, which is nonsensical)
- [x] Joint bill shares should not appear in the Personal ledger at all; Joint ledger should
      show full bill amount, not the per-person share
- [ ] "Land on cycle period" option added alongside "follow payday"; checkboxes grey out
      day-of-month field when ticked; wording matched with Transfers page; row collapsible
- [x] Deletion guard: transactions/bills/transfers created **today** hard-delete regardless
      of cleared status (this is also what fixes the stray pot balance bug above)
- [x] Pots editable fields currently only name. Let’s make use of the space and permanently move the manage payments form this pot list into this dark-background form, still as a checklist, and drop the red inline text button to manage.
- [ ] Savings/joint account/pots log deposit/withdrawl and recurring all need a location (to location if withdrawn, from location if deposit). Remember anything created here will auto create the transfer in the transactions page. Further to this, when creating a recurring, this should all be picker modals. First in the flow is the amount, second is the location (from or to based on deposit/withdrawal), third is frequency (options will be weekly, every n weeks, monthly, quarterly, annual, follow pay day or follow pay cycle), and if user selects weekly, every n weeks (gets it’s own step 3a to state number of weeks), monthly, quarterly or annually, then step 4 is a date picker. Step 3a and 4 get skipped if user selects follow payday or pay cycle (search the app for the commonly used wording). This is the standard for all recurring transfers (deposits or withdrawals). This should be the exact same flow when creating recurring transfers in the transactions page except we insert a to location after step 2. For log a deposit or withdrawal, flow is shorter, step 1 is amount, step 2 is from location. This is the same flow used on the transfer section in the transactions page, only has a step 3 for to location. If using the salary page to log these transactions, for deposits, the to location is whatever the deposit is being built on (pot, savings pot or joint account), and reversed for withdrawals, the from location is the target where the withdrawal is being built on.

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

**2026-09-04 — Batch 3, two checklist items clarified before building.** Two of the six
items read as more concrete than the actual code supported, so confirmed with Adam rather
than guessed:
- *"'What this pot pays' header shows opening balance + net activity, not raw balance"* —
  the literal string "What this pot pays" only exists on the bill/loan checklist label
  (no balance display there at all); the plain-balance display Adam actually meant was the
  Wallet page's collapsed pot row. Confirmed: Wallet page pot row, not the checklist label,
  not the Summary-page detail card (which already showed `£X now · £Y projected`).
- *"Recurring deposit step 2 card gets Save/Cancel and becomes collapsible"* — the existing
  recurring-deposit editor auto-saved every field live, no draft state. Confirmed: convert
  to a real draft-then-commit pattern (Cancel reverts, Save commits), collapsed by default
  — not just bolting a no-op Save button onto the existing live-editing behaviour.

Also found and fixed one near-miss while building the Joint pill: the app already has a
`--color-joint` CSS token, but it's `#fdfdfd` (a near-white `BankCard` background fill, not
a badge accent) — using it for white-on-token badge text would have reproduced the exact
invisible-Cancel-button bug from Batch 2, just on a new element. Used a neutral outlined
pill (same border-based approach as that fix) instead.

**2026-09-04 — Batch 3 addendum, "Set as me" request clarified.** "Set as me" was
deliberately moved off the Salary rows into a dedicated People modal in an earlier session
(2026-09-02, "household ownership model" decision). Adam's "always show the salary 'Set as
me' at the top of the salary section" did NOT mean reversing that move — confirmed it means
the primary person's row should always be sorted first in the Salary section's own list.
The People modal remains the only place to actually change who's primary.

**2026-09-04 — Batch 4, item 1 (Salary Sort → real transfers) found already built.** Before
writing any code, cross-checked the checklist against the actual current code (per the
"docs may describe an earlier plan, verify before relying on them" instruction) — the entire
mechanism (`lib/salarySortLedger.ts`, `saveSalarySort`/`clearSalarySortTarget`/
`clearSalarySort`/`dropSalarySortTarget` in `LedgerContext.tsx`, `SalarySortModal` in
`Salary.tsx`) already existed, committed as part of the "8 days of uncommitted UAT work"
snapshot predating Batch 1. Each sort target creates a real `type: 'transfer'` transaction
(`sourceType: 'salary_sort'`) visible on the Transfer page; deleting it drops just that
target from the sort; clearing a target/whole sort deletes the matching transaction(s).
Confirmed with Adam this only needed live verification, not a rebuild — see live-testing
notes once done.

**2026-09-04 — Batch 4, item 3 (joint bill shares in Personal ledger) — root cause found and
reversed.** `lib/jointLedger.ts`'s `generateJointContributionTransactions` was deliberately
folding each person's own SHARE of every joint bill/loan into their Personal ledger
projection (`projection.ts`) AND materializing it into a real, permanently-cleared
Transaction once due (`autoClear.ts`) — built in an earlier session specifically to fix a
then-flagged "joint costs invisible in Personal" gap. Adam's explicit call: reverse it
entirely — Personal shows nothing about joint bills now, full stop. Removed both call sites;
the generator function itself is kept (still used by `salarySortLedger.ts`'s joint-top-up
suggestion, a pure calculation, never displayed as a personal transaction) and the Household
card's own filter for this shape (`householdLedger.ts`) is deliberately left in place, since
it's still correct for any transaction already materialized under the old code (cleared
transactions are immutable historic fact, per the app's own rule — never retroactively
rewritten). Checked Adam's real fixture backup (`backup-2026-09-02.json`) for any
already-materialized "Your share of X" rows — none found, so no retroactive data cleanup was
needed this time; flagged here in case an older backup ever surfaces one. Two verify scripts
(`verify-ledger-phase3.ts`, `verify-joint-account.ts`) had "sanity check" assertions baked in
that literally asserted the old (now-reversed) behaviour — updated to assert the new one.
Full verify suite + `tsc -b` re-run: no new regressions (same pre-existing gaps as always).

**2026-09-04 — Batch 4, item 5 (deletion guard for today-dated cleared transactions).**
Confirmed with Adam: "created today" means the transaction's own `date` field equals today
(there's no creation-timestamp field anywhere on `Transaction`); applies to BOTH the
generator-delete sweep path AND direct single-transaction deletion. Investigated the direct
path first (`removeTransaction` in `LedgerContext.tsx`, wired to every row's swipe-to-delete
in `Expenses.tsx`) — it already deletes unconditionally regardless of cleared status or date,
no guard exists there to begin with, so nothing needed changing on that path. The real gap
was the five `sweepPending*` helpers (`LedgerContext.tsx`) that run when a Loan/CreditCard/
RecurringTemplate/Pension/SavingsPot/Pot is deleted — they kept every cleared transaction
forever ("cleared is immutable"), which is exactly the mechanism behind the stray-pot-balance
bug (a cleared recurring-transfer occurrence surviving deletion of its template). Added a
shared `isSweepableOnGeneratorDelete(t, asOfIso)` predicate (pending OR dated `asOfIso`) and
threaded an explicit `asOfIso` parameter (defaulting to real today) through all five sweep
functions, so today-dated cleared rows now get swept away too, everything older stays
immutable exactly as before. `scripts/verify-pending-sweep-on-delete.ts` gained one new
today-dated-cleared case per entity type. Full verify suite + `tsc -b` re-run: no new
regressions.

**2026-09-04 — Batch 4, item 1 live-tested — found and fixed one real display bug.** The
data-layer mechanism (see the earlier note above) was fully correct, but the Transfer page's
own one-off list (`Expenses.tsx`'s `transferTransactions`) filtered to `!t.sourceType` only —
written before the Salary Sort mechanism existed, so it silently excluded every
`sourceType: 'salary_sort'` row. The transaction was real and correctly synced, just
invisible on the one screen the spec explicitly promises it on ("I can edit them here").
`TransferRowItem`'s own coral-arrow "Salary Sort · Destination" special-casing was already
built and correct, just unreachable. Fixed the filter to `!t.sourceType ||
t.sourceType === 'salary_sort'`. Verified live in a headless-Chromium browser against Adam's
real fixture backup end to end: created a pot, moved a bill into it, sorted a salary
(correctly prefilled £37 = the bill's due amount), confirmed the resulting transfer now
appears on the Transfer page as "Salary Sort · Bills Pot", and confirmed "Clear this sort"
deletes the transfer and reverts the sort icon to unfilled. `tsc -b` + full verify suite
re-run: no new regressions.

**2026-09-04 — Batch 4, item 6 (pot checklist relocation) — built and live-tested.** The
bill/loan checklist (`PotBillsAndLoansControl`) used to be its own click-to-reveal card
behind a red inline "Manage what this pot pays" text button, sitting outside `PotEditForm`.
Folded permanently into `PotEditForm` itself (shared `potEligibleItems` helper extracted so
both the checklist rendering and the Save handler's location-reassignment loop read the same
list) — one card, one Name field, one always-visible checklist when the pot has eligible
bills/loans, one Save button that commits both the name and any bill/loan reassignments
together. The red inline button is gone. Verified live: creating a pot now opens straight
into this merged form, checking a bill shows it as dirty, and Save persists both the pot and
the bill's new location together (collapsed summary correctly updates to "pays 1 bill/loan").
Pure UI change, no `lib/` files touched — confirmed by direct code review plus a clean
`tsc -b` rather than a verify script.
