# Shared Supabase Backend — Migration Plan

This picks up from `PWA-MIGRATION.md`. That doc left seven Open Questions
unresolved; this one resolves the three that were blocking table design and
documents sensible defaults for the rest, flagged clearly where they're
assumptions rather than confirmed decisions.

> ## Current state (read this first)
> Everything below was written across several sessions and reflects the
> reasoning *as it developed* — some sections (especially "Cross-device
> household linking" and the PowerSync architecture) describe an early
> plan that was later built differently in real, important ways once it
> was actually implemented. Rather than rewrite history, the sections
> below are marked with **✅ BUILT** / **⚠️ SUPERSEDED** callouts showing
> what actually shipped versus what was originally sketched. For the
> single current-truth summary, read `HANDOFF.md`. For the actual
> PowerSync setup steps, read `POWERSYNC-SETUP.md`. For every gotcha hit
> along the way, read `MIGRATION-LESSONS.md` — several of the "not yet
> wired" caveats below turned into real, documented lessons once they
> were.
>
> **The short version of what changed from the original plan:**
> - Link codes are **permanent and reusable**, not 15-minute single-use
>   (Adam's explicit call, made after this doc's design was written).
> - The "what happens to a joining device's own data" open question
>   (below) is **resolved**: the joining user's own salary + personal
>   bills/loans survive, everything else is replaced, via a real
>   `linked_user_id` column and merge-aware `redeem_household_link_code()`
>   — not any of the three originally-sketched options verbatim.
> - PowerSync is **fully built and wired**, not just designed — real
>   Sync Streams (PowerSync's terminology evolved from "sync rules
>   YAML" to "Sync Streams" between when this was written and when it
>   was built), a real client connector, `AppContext` genuinely sourcing
>   from it instead of `localStorage`.

## Progress log

- **Infra deployed.** Supabase project created (`nxekrfdagkdwhjuunsrl`),
  schemas + grants + storage buckets + RLS live for all three apps.
  `20260831120001`–`20260831130000` all applied via the GitHub integration.
- **Auth configured.** Google OAuth, Site URL, and wildcard Redirect URLs
  for all three deployed app URLs are set, plus `http://localhost:5173/**`
  for local dev testing.
- **my-dream-clean — shipped.** Auth gate, sign-in, Change Password, and
  cloud backup/restore against `my-dream-clean-backups` deployed and
  tested end-to-end. Done, nothing further planned.
- **personal-finance — shipped and in real-world testing.** Full auth
  layer, household linking (permanent link codes, merge-on-redeem,
  `linked_user_id`, `DuplicatePersonBanner` for flagging leftover
  duplicates), cloud snapshot backups, and a complete PowerSync
  integration (`AppContext` now sources from PowerSync's local database,
  not `localStorage`) are all built, typechecked, and build-verified.
  Currently in real multi-device testing — see `HANDOFF.md` for the exact
  next steps.
- **personal-finance-ledger — infra live, app-feature work underway.**
  Tables/RLS from `20260831120002` are live. The Supabase migration
  itself is still deliberately paused (see "Status & what's next"
  below), but Adam's feature backlog that's blocking it is now well
  underway directly against the app: items b, c, and **f are fully
  done** (f went through a substantial scope correction mid-session —
  see f-addendum in the backlog section for the real final design); a
  is done and stable (a-addendum); d and e remain, with d up next — see
  d's own section for the prompt to open that session with.

## Status & what's next

**personal-finance is done building; personal-finance-ledger is next,
once Adam's feature backlog (below) is complete.** Everything this
section originally said about "phase 2, not yet wired" for
personal-finance's household linking and PowerSync is now simply
finished — see the callout at the top of this doc. The one thing that
hasn't changed: personal-finance-ledger's migration is still deliberately
paused until the backlog below reshapes what its tables need to hold.

**Backlog status: a, b, c, f done; d up next (prompt in item d's own
section below); e and g after that.**

**For personal-finance-ledger, when the backlog is done, the replay order
is now well-established** (this is genuinely useful — personal-finance
was built from a partial design, personal-finance-ledger gets to be built
from a finished, working reference):

1. Revise the schema-affected tables per whatever the backlog actually
   produced (`savings_entries`, `salary_history`, `scenarios` per the
   backlog items below) — write this as the app's real shape, not a guess,
   since the backlog work will have made the real shape known by then.
2. Add household-linking tables (`households`, `household_members`,
   `household_link_codes`) **plus `linked_user_id` on `people`+trigger
   from the start** — personal-finance needed a follow-up migration to
   add this after the fact; don't repeat that here (`MIGRATION-LESSONS.md`
   §5).
3. Add `ensure_household()` in the same migration, not as a later
   follow-up (`MIGRATION-LESSONS.md` §17).
4. Design link codes as permanent/reusable from the start (skip the
   15-minute-expiry design entirely — it was superseded for
   personal-finance and there's no reason to build it here just to
   replace it again).
5. Extend the *existing* PowerSync role/publication/instance — do not
   create new ones (`POWERSYNC-SETUP.md` §1, `MIGRATION-LESSONS.md` §6).
6. Build the six-file `src/lib/powersync/` structure (`schema.ts` →
   `household.ts` → `mapping.ts` → `database.ts` → `connector.ts` →
   `writes.ts`) plus the `AppContext`-equivalent rewrite, following
   personal-finance's actual files as the template (`POWERSYNC-SETUP.md`
   §7 has the full breakdown of what each one does).
7. Watch for the source-table-aliasing gotcha in Sync Streams
   (`MIGRATION-LESSONS.md` §7) and the `CREATE OR REPLACE` return-type
   gotcha if any function's signature changes shape during this work
   (`MIGRATION-LESSONS.md` §13).

## Decisions confirmed this session

1. **Shared identity.** One `auth.users` table across all three apps. Signing
   into any app with the same email is the same account everywhere.
2. **Storage isolation is RLS-enforced, via bucket-per-app** (not the
   originally-sketched single bucket with an app-slug path prefix). Each app
   gets its own private bucket — `personal-finance-ledger-backups`,
   `personal-finance-backups`, `my-dream-clean-backups` — so cross-app
   isolation is structural (different bucket) rather than needing a custom
   JWT claim to identify which app is asking. Within each bucket, RLS still
   checks the `{user_id}/...` path segment to isolate users from each other,
   same as before.
3. **Historized fields normalize into relational tables** where the source
   data is actually historized (ledger's `salaryHistory`,
   `recurringTemplates[].amountHistory`, `loans[].overpayments`,
   `loans[].statementCalibrationLines`, `creditCards[].minimumPaymentOverrides`,
   `people[].salaryOverrides`). Where a field is a single nested object, not
   a list (e.g. personal-finance's `savingsGoal`, credit cards'
   `minimumPayment`), it's flattened onto the parent row instead — there's
   nothing to normalize, it's 1:1 already.

## Still open (not blocking, but real)

- ~~Open Question 2 from the original doc — shared `public.profiles` vs.
  per-app profile data~~ **Resolved.** BLOC's `profiles` table lives in a
  separate Supabase project with its own `auth.users` table, so there was
  never a way to share it with this project regardless of preference —
  Postgres schemas don't span projects. The `public.profiles` table created
  by `20260831120001_shared_baseline.sql` is this project's own, and is the
  only option. No conditional block needed in that migration file anymore.
- ~~Dashboard "Exposed tables" panel showing 0 of 24~~ **Resolved — not a
  bug.** Checked `information_schema.table_privileges` directly: every
  table in both custom schemas has `select/insert/update/delete` granted to
  `authenticated` and nothing granted to `anon`, exactly as designed. The
  panel almost certainly counts `anon`-role exposure specifically (the
  public-facing risk it exists to flag) — zero there is correct for
  sign-in-required apps, not a sign anything failed.
- **`public.profiles` had a real gap**, found by the same check: `authenticated`
  was missing `UPDATE` (had select/insert/delete only), which would have
  silently blocked profile edits at the grant layer before RLS was ever
  evaluated. Fixed in
  [`migrations/20260831130000_fix_profiles_grants.sql`](migrations/20260831130000_fix_profiles_grants.sql),
  which also tidies unintended `references`/`trigger`/`truncate` grants that
  neither prior migration issued (inert through the Data API, but not
  something we meant to grant).
- **Two sub-table shapes are best-guesses, not confirmed data:**
  `loan/credit-card lump payments` and both apps' `savings_entries`. Every
  record in both backup files has these as empty arrays, so there's no real
  example to read the shape from. I've given them a shape consistent with
  their nearest sibling (date/amount/note), but treat these as draft until
  you've got a real entry to check against.

  **✅ Partially resolved for `personal_finance`:** its `savings_entries`
  guess turned out wrong once checked against the app's real
  `SavingsEntry` type — fixed in
  `20260902093000_personal_finance_fix_savings_entries.sql`. **Still
  open for `personal_finance_ledger`** — its `savings_entries` guess in
  `20260831120002` hasn't been checked against anything real yet, and
  almost certainly has the same problem; see `MIGRATION-LESSONS.md` §16.
  `loan`/`credit-card` lump payments in the ledger schema are still
  unconfirmed guesses too.
- **`scenarios` is a placeholder `jsonb` table in both apps** for the same
  reason — empty in both backups, real shape completely unknown. Don't build
  UI against it yet; revisit once a scenario exists in either app.
- **OAuth provider list, migration repo structure, app-slug naming** — I
  assumed shared config / one shared infra repo / the slugs you gave me
  directly (see below), matching the original doc's own recommendation.
  Flag if any of those should be different.

## Personal-Ledger feature backlog — prerequisite to migration

**Scope note up front:** this is real app-feature engineering against
`personal-ledger`'s actual React codebase (60+ source files, its own
`scripts/verify-*.ts` regression-test suite covering the amortisation
engine, tax engine, and ledger logic in real depth). Recorded as a
structured backlog — grounded in what the current code actually does,
not a guess — for Adam to work through directly against the app's real
components, `lib/` modules, and its existing verify-script pattern (every
`scripts/verify-*.ts` file is a hand-written regression check with no
test framework — new logic should get the same treatment).

**Source:** this backlog was substantially expanded from Adam's own
`App_Dev.md` (consolidated into this doc rather than kept as a separate
file, since it's the same backlog this section already existed to
track) — six items now, not four: the original a/c/d below are
essentially unchanged in spirit but now have Adam's own detailed
implementation steps; b split into two separate items (salary end date,
pension income — genuinely different features, not one); and credit
card accounting periods is new.

## Personal-Ledger session log — 2026-09-02

Items b and c are fully done (marked ✅ above); f is partially done — the
real-transaction data layer is built, but the ledger-parity UI Adam
actually intended is still outstanding (see f's own addendum below); a,
d, and e remain untouched. This section is the architecture record for
what actually got built — the "why," not just the "what," since several
decisions here reach well past b/c into how the whole app (and
eventually the Supabase schema) is shaped.

**Follow-up session, same day, plus five further bug-fix rounds through
2026-09-03: item a (savings overhaul) is now ✅ BUILT AND STABLE** — see
item a's own section and its a-addendum below for the full record
(interest engine, every UI surface, the real bugs found across the
fix rounds, and the lessons-learnt writeup). Remaining untouched: d and e.

**Household ownership model — the session's biggest structural
decision.** Working through where a Pension's owner lives surfaced a
question bigger than Pension itself: how does ownership work at all,
now and once household linking (cross-device) lands? Resolved:
- `Person` was **already** fully independent of salary/linking before
  this session — `addPerson()` has always created someone with empty
  income, and Bills/Loans have always carried an explicit `ownerId`. Not
  new architecture; this session mostly *confirmed* the existing shape
  rather than changing it.
- **Pension is a top-level, `personId`-owned entity, not nested under
  `Person`** — see item c above for the full reasoning (concurrent
  income vs. salary's succession model).
- **Savings will follow the same pattern** once item a (savings
  overhaul) is built — pulled out of `Person.savingsEntries[]` into its
  own top-level, `personId`-owned table, matching Pension/Loan/Bills.
  Confirmed and locked in as the target shape; **not built yet**, since
  item a itself hasn't started. Whoever picks up item a should build
  straight to this shape rather than the old nested one.
- **"Set as me" moved from Salary rows to a dedicated People modal**
  (new "People" icon, top-right of Wallet) — add/rename/remove/Set-as-me
  all live there now, always available regardless of anything else on
  the page. `primaryPersonId` itself is unchanged and still load-bearing
  in ~10 files; only *where the control lives* moved.
- **Every "add a new X" flow across the whole app is now the same
  shape:** with exactly one person, no picker — the new record silently
  binds to them, field hidden entirely. With 2+, a person-picker screen
  first, then the form. Applied consistently this session to Salary,
  Pension, Savings, Loans, and Credit Cards (Loans/Credit Cards already
  had an owner field but not the picker-first step — added). Pension's
  form additionally keeps that same field live and editable when
  *editing* an existing pension (real top-level ownership, freely
  reassignable) — Salary and current-model Savings can't do that
  cleanly since they're still nested/owned-by-array-membership, flagged
  explicitly rather than half-building a "move between people" feature
  for Savings right before it's rebuilt anyway.

**Wallet page (renamed from "Salary") — full redesign, not just a
pension bolt-on.** Type-grouped, always-visible, collapsible sections —
Salary / Pensions / Savings, each with its own "+" (mirroring Borrowing's
Loans/Credit Cards layout) rather than Borrowing's old "always show, even
empty" pattern. Each row (a person's salary block, a Pension, a Savings
entry) is individually collapsible, matching `LoanRow`'s pattern.
Calendar icon ("Following," `CalendarClock`) sits in the Salary section
header normally, falling back to the Pensions header once nobody in the
household has a salary left — opens a sheet with one radio group per
person who has 2+ active income sources, picking which one
`pay_cycles.follows_income_source` points at.

**Cycle-boundary following — the actual biggest piece of engineering
this session, bigger than Pension itself.** Started as "add a picker for
which income source the cycle follows" and turned into: that picker
didn't do anything beyond labeling until the cycle-boundary math itself
was made to actually read it. Concretely:
- `lib/payCycle.ts` stays foundational (pure date/UK-bank-holiday math,
  no knowledge of `Pension`/`AppDataV2`) — `adjustToWorkingDay` extracted
  as its own reusable function (behaviour-preserving refactor of
  `resolvePayday`'s inline loop).
- `lib/pensionLedger.ts` gained `pensionCycleBounds` (a frequency-aware
  generalization of `payCycle.ts`'s day-of-month-only
  `paydayCycleBounds`, reusing the same "collect a wide window, pick the
  true predecessor" strategy against ANY `RecurrenceFrequency`, not just
  monthly) and `resolveCycleBounds(data, personId, date)` — **the one
  function every call site should use now** for "this person's current
  cycle window." Dispatches on `followsIncomeSource`: salary (or a
  pension with `cycleStartFollowsPayday` off) uses the existing,
  unchanged `payCycle.ts` math; a followed pension with it on uses its
  own resolved schedule.
- `Pension` gained its own `adjustForNonWorkingDay`/
  `cycleStartFollowsPayday` fields — same two checkboxes salary's forms
  already had, now on Pension's form too, unticked by default (vs.
  salary's ticked/unticked split), since a pension's cadence varies far
  more than salary's.
- Every real call site updated: `projection.ts` (`horizonCycles`/
  `horizonRangeEnd` gained `data`+`personId` params, replacing a bare
  `payCycle` — the one public signature change from this work),
  `purchaseImpact.ts`, `Home.tsx`'s Joint card. Zero behaviour change for
  anyone not actively following a pension with the new checkbox on —
  confirmed directly against Adam's real backup (see Verification
  below), not just asserted.

**Bug fixes found and fixed along the way (not separately requested,
folded into this work):**
- `CollapsibleSection`'s `headerExtra` was hidden whenever the section
  was collapsed (`{open && headerExtra}`) — a genuine app-wide bug
  affecting every "+" on Wallet, Borrowing, *and* Dashboard, fixed with
  a one-line change to the shared component.
- Two modal instances (`PeopleModal`, the new `FollowingPickerModal`,
  and a **pre-existing** one — `PayCycleSettingsModal`) were missing the
  `max-h-[85vh] overflow-y-auto` + nav-bar-clearing `paddingBottom` every
  other modal in the app already has (`DeductionModal` is the reference
  implementation) — all three now match it.
- A Wallet-row background-color regression (two spots swapped to the
  same CSS variable, making the pay-period pills blend into their card)
  — introduced and fixed within this session, caught from Adam's own
  before/after screenshots.

**Verification.** Every change in this session is backed by
`scripts/verify-*.ts` (existing suite kept green throughout, plus new
coverage: `verify-pension-ledger.ts` for the generation engine and the
weekend-adjustment/cycle-bounds logic, `verify-salary-end-date.ts` for
item b). **`scripts/verify-real-backup-2026-09-02.ts` is new and worth
knowing about specifically** — Adam provided his actual household backup
plus screenshots of the live app's real figures, and this session's
cycle-boundary refactor is checked against it directly: Beverley's
current balance/pending/projected (£288.00 / £3,812.62 / £4,100.62) and
all four horizon cycle boundary dates come out byte-identical to the
screenshotted app. `scripts/fixtures/backup-2026-09-02.json` holds the
fixture itself — treat it the same as the existing
`backup-2026-08-24.json` (real data, not synthetic, gitignored contents
aside from what's actually committed).

**File delivery this session.** `git apply`-style patches turned out to
be the wrong fit — too easy for the working tree to drift from what a
patch was diffed against, especially across a session this long. Adam's
preferred method going forward: **a single zip containing only the
changed files, laid out in their real `src`/`scripts` folder structure**
— extracted and merged file-by-file (never dragging a whole folder on
top of an existing one, which risks a full-folder replace wiping
unrelated files). Whichever session picks up next should default to
this over a `.patch` file unless Adam says otherwise.

### a. Savings overhaul — cards, not salary attachments ✅ BUILT (2026-09-02 follow-up session)

**Built.** Savings moved off `Person.savingsEntries[]` onto a genuinely
top-level, `personId`-owned `SavingsPot` entity — architecturally
identical to `Pension` (own occurrence-walker file, `lib/
savingsPotLedger.ts`, mirroring `pensionLedger.ts`'s structure closely on
purpose), not nested under `Person`. `Person.savingsEntries`/
`SavingsEntry` are kept in `types/ledger.ts` ONLY so an already-persisted
backup's legacy goals/plans still round-trip through `lib/legacyBridge.ts`
and `clearTransaction.ts`'s existing `savings_contribution` side effect —
nothing in the app creates new entries there any more. **Flagged, not
silently left:** `Scenarios.tsx`'s "target a savings goal" what-if action
still reads that now-permanently-empty array — it will simply never show
for anyone who didn't already have a legacy goal before this session.
Item d (what-if scenarios) hasn't been touched; whoever picks it up next
should decide whether to re-point it at `SavingsPot` targets instead.

**Interest engine (step 3) — two of the considered methods built, one
explicitly deferred:**
1. **AER-credited** — interest calculated against the balance at the
   START of each period, credited/compounded at a chosen frequency
   (monthly/quarterly/annual). Cheap, matches most easy-access accounts
   closely enough, doesn't need the pot's full transaction history.
2. **Daily-accrual, monthly-credited** — the realistic convention: a
   daily rate accrues against the ACTUAL daily balance (replaying every
   deposit/withdrawal — a deposit starts earning from its own date, not
   from the next crediting date), credited into the balance once a
   month. Needs the pot's full activity history to compute correctly.
3. **Fixed-term/bond-style — DELIBERATELY NOT BUILT.** Considered and
   documented (rate locked for a term, no further deposits after
   opening, interest paid annually or at maturity) but flagged as
   near-term future work rather than guessed at now — Adam's own call,
   anticipating ISA/bond-style products will need it, which genuinely
   need a term/maturity-date field and a "deposits disallowed after
   opening" constraint neither built method has. Whoever picks this up:
   see `SavingsInterestMethod`'s own comment in `types/ledger.ts` and
   `lib/savingsInterest.ts`'s file header for the full menu of
   conventions considered (simple interest, tiered/banded rates were
   also weighed and set aside for the same reason).

Both methods are calibrated against a real-money worked example, not
just unit-tested against invented numbers — `lib/savingsInterest.ts`'s
`buildExampleLedger()` produces the exact same output shown to Adam in
the save-time explanation pop-up below, so the UI and the engine are
provably showing the same maths, not two independently-written versions
of it.

**UI, in full:**
- **Wallet (`Salary.tsx`)** — the Savings section's old goal/plan cards
  replaced entirely with pot cards. Creation asks "new pot (£0, opens
  today) or existing (real opening balance + date)" FIRST, before any
  other field — anything dated before `openingDate` is ignored
  completely by every calculation in `savingsPotLedger.ts`, not just
  hidden in the UI. Interest-method fields are dynamically shown/hidden
  (the crediting-frequency picker only appears for `aer_credited`, since
  `daily_accrual_monthly_credited` has no frequency choice at all).
  Saving — whether on creation OR a later rate change — opens
  `InterestExplanationModal`: a plain description of the chosen method
  plus a worked £1,000 example ledger, before the save actually commits.
  Rate changes go through the same historized `applyInterestMethodChange`
  pattern as Pension's amount changes.
- **Info-icon ledger modal** (`SavingsPotLedgerModal`) — same
  bottom-sheet/"tap a row to adjust" pattern as `CreditCardLedgerModal`
  (`Loans.tsx`), placed the same way (an Info icon on the pot's own row,
  not on the Home summary card — matching where the credit card
  equivalent actually lives). Shows the ramp-up preview window: a
  brand-new pot shows next-12-only; 1 month old shows last-1+next-12;
  2+ months old shows last-2+next-12 (steady state) — the exact same
  "don't fabricate history that never happened" fix already proven on
  `buildCreditCardMinimumChargeRows`. Only interest rows are tappable;
  deposits/withdrawals are shown but not editable from here, per spec.
- **Transactions page (`Expenses.tsx`)** — a third pill, "Savings",
  next to Transactions/Recurring (only rendered once ≥1 pot exists
  anywhere). Its add-form swaps Expense/Income for Deposit/Withdrawal,
  with a pot-picker scoped to "the person set as me" — invisible with
  exactly one of their own pots, a dropdown with 2+, same "silently bind
  vs. picker" rule as every other person-picker in this app. (Genuinely
  open edge case, flagged in-code rather than silently resolved: if the
  primary person owns NO pots themselves but someone else in the
  household does, the picker falls back to every pot rather than
  hiding — untested against a real scenario since it doesn't apply to
  Adam's own household today.)
- **Home summary page** — the existing goal-progress ring mechanism
  (`ProgressRingsSection`) repointed from `savingsEntries` to
  `SavingsPot.targetAmount`-set pots, with a genuine "This cycle → Next
  3 cycles" projected ring (recurring deposits + projected interest,
  not just already-cleared activity). New `SavingsPotsSection` below the
  swipeable deck: one card per pot with current balance, this-cycle/
  next-cycle-end projections (via `resolveCycleBounds` — the SAME
  cycle-boundary math the Personal card itself uses, not a separate
  approximation), a recent+upcoming activity list with interest and
  deposits always shown positive/green (mirroring `CardActivityRow`'s
  type-derived-sign convention for credit cards), and the target-date
  info label. **Scope note, flagged rather than silently equated:**
  these render as their own visually-distinct cards BELOW the
  swipeable Personal/Joint/Household/credit-card deck, not as an
  additional swipeable deck page with its own Group-by/Order-by/
  cycle-end-totals controls — extending `SummaryCardKind`/`buildDeck`/
  `SwipeCards` to give pots that full treatment would be the same scale
  of work item f's still-open household ledger-parity addendum already
  shows that needing. Worth a future pass if genuinely wanted; not
  quietly built as a lesser version and called equivalent.
- **Two independent goal triggers, exactly as specified:**
  `targetAmount` alone drives the pie-ring on the Home summary
  (`ProgressRingsSection`); `targetDate` alone drives a plain info-only
  "save £X per [pay frequency] to hit this by [date]" label on the
  pot's own summary card, computed off the pot owner's currently-active
  `SalarySnapshot.payFrequency` (`amountNeededPerPayPeriod`) — never the
  other way round, and setting both never lets `targetDate` override the
  pie chart's own pace-based projection.

**Verification.** `scripts/verify-savings-pots.ts` — 30 checks: rate
conversion sanity, balance derivation (including "anything before
openingDate is ignored entirely"), both interest methods (including the
mid-period-deposit daily-accrual case that method 1 structurally can't
get right), manual interest overrides, recurring-deposit pause/unpause,
the ramp-up preview window at all three ages, schedule-row
overridability, rate-change historization, both goal triggers, and the
example-ledger generator. `scripts/verify-backup-savings-simulation.ts`
is new and specifically exercises Adam's real household backup
(`scripts/fixtures/backup-2026-09-02.json`, which genuinely predates
BOTH pensions and savings pots — neither key exists in the raw file):
confirms it loads cleanly through the new `savingsPots: data.savingsPots
?? []` default, simulates adding a new £0 pot, a £200 deposit, and a £50
withdrawal, and — the check that actually matters most — confirms
Beverley's real screenshotted opening balance and all four horizon
cycle-boundary dates come out byte-identical before and after, proving a
savings pot is genuinely independent of the personal-ledger cycle math
rather than accidentally coupled to it.

**File delivery this session.** Single zip, changed files only, real
`src`/`scripts` folder structure — same convention as before.

**Schema implication (unchanged from the original scoping, now
confirmed against real code rather than guessed):** `savings_pots` table
(`id`, `person_id` FK, `name`, `opening_balance`, `opening_date`,
`active`, `target_amount`, `target_date`) + `interest_method` as a
`jsonb` column (discriminated union, same "jsonb for a genuinely variant
shape" call already made for `pay_cycles.follows_income_source`) +
`interest_method_history` child table (same normalization treatment as
`salary_history`/`pension_amount_history`) + `interest_overrides` child
table + recurring-deposit columns mirroring `pensions`' own scheduling
columns. `transactions` gains `savings_pot_id` (FK, nullable, like
`credit_card_id`), and `type` gains `'savings_deposit'`,
`'savings_withdrawal'`, `'savings_interest'` (`'savings_contribution'`
kept as a valid historical value, never written again). The old
`savings_entries` placeholder table this replaces was already flagged
as a best-guess in the original scoping — this is that guess resolved
against the real, now-built shape.



**Current state** (`src/lib/savings.ts`, `types/models.ts`): `SavingsEntry`
is an array on `Person`, two kinds (`goal` | `plan`), no support for
tracking an actual pot balance separately from a goal's `currentAmount`, no
way to record a withdrawal as income.

**Requested — Adam's own implementation steps:**
1. Remove the Add Savings button from the salary card.
2. In the "+" New Salary button, add the option to create a savings pot.
3. On selection: name the pot, set an opening balance + opening date, set
   an interest rate. **Needs a basic amortisation engine built for
   savings specifically** — research common interest-rate calculation
   methods (simple vs. compound, AER vs. gross, compounding frequency)
   and make sure the right fields are captured to support whichever
   method(s) get built, not just a bare percentage.
4. Add monthly recurring deposits into the pot. Once saved, show the next
   12 as pills (same pattern as recurring transactions elsewhere in the
   app), editable per-row or "all future" — amount and date only, nothing
   else editable. Optional target amount on the pot.
5. Interest-rate edits should trigger the same "when do these changes
   take effect from?" date-picker prompt already used elsewhere in the
   app for salary/rate changes — banks change rates; this needs the same
   historized-change pattern, not a silent overwrite.
6. New savings pots show as their own card on the summary page.
7. Savings cards show current balance, cycle-end projections (same
   mechanism as the personal account), a full ledger of deposits/
   withdrawals, and interest earned as its own transaction line —
   **needs a recommendation on when/how interest gets paid**, based on
   whatever the step-3 interest engine ends up supporting.
8. Transactions page: add a third top-level option, **Savings**, but
   *only* when at least one savings pot exists. Two sub-options at the
   top of that transaction card: **Withdraw** or **Deposit**.
   - Withdraw: date + amount, debits the pot, credits the personal
     account — visible as income-equivalent in the summary page *and* as
     a withdrawal in the pot's own ledger.
   - Deposit: date + amount, debits the personal account, credits the
     pot — same two-sided bookkeeping, opposite direction.
9. If a pot has a target, show a pie chart at the bottom of its summary
   card with a projected date the target will be met, based on current
   balance plus everything pending (planned one-off deposits or the
   recurring schedule).
10. Pausing recurring deposits: tap any upcoming deposit pill, pause —
    skips that one and every future occurrence. Un-pausing from a future
    deposit re-enables from that date forward. This revises the "amount
    and date only" editable-fields rule in step 4 — pause/unpause is a
    third, distinct action alongside editing a single row or all future
    rows.

**Schema implication:** the `savings_entries` table in
`20260831120002_personal_finance_ledger.sql` is already flagged as a
best-guess placeholder (empty in every backup record) — this feature is
exactly what replaces it, and per `MIGRATION-LESSONS.md` §16,
`personal_finance`'s own equivalent guess already turned out wrong once
checked against a real type, so treat this one with the same suspicion
until the real shape exists. Don't build the Supabase sync layer against
the current shape; it's about to change completely, likely into
something closer to a `savings_pots`/`savings_transactions` pair than a
single table.

---

### a-addendum. Post-delivery bug-fix rounds (2026-09-02 → 2026-09-03) — final status + lessons learnt

Item a went through five further rounds after the initial build, all
against Adam's real, live use of the feature rather than synthetic
review. **Status as of 2026-09-03: stable.** Every bug below is fixed,
verified (either by an automated check or, for two, by real DOM
interaction tests — `src/pages/SavingsPotForm.test.tsx`, `npm test`),
and the in-app debugging aid added mid-investigation has been removed
now that its job is done. What follows is the honest record of what
went wrong and why, specifically so the pattern doesn't repeat on the
next feature that touches multiple existing consumers.

**Bugs found and fixed, in the order they surfaced:**
1. Recurring deposits/interest were wired into `computeProjection` (the
   Home page's projection engine) but never into `autoClearDuePayments`
   (the function that promotes a due occurrence into a real, permanent
   transaction) — so a due deposit never actually materialized, and kept
   being recomputed fresh off the pot's *current* standing amount
   forever, which looked exactly like "changing my rate retroactively."
2. The interest explanation modal's Back/Confirm buttons were the last
   children inside the same scrollable region as the worked-example
   ledger — a real, known mobile failure mode (a tap inside a
   not-yet-resolved scrollable container can be swallowed) that
   presented as "first tap does nothing, second tap works."
3. Several fields in the pot form had no explicit `key`, and were
   conditionally shown/hidden by sibling state (interest method,
   deposit amount crossing zero) — React can silently reuse a number
   field's instance, raw text and all, for a different logical field
   when a sibling's presence shifts everyone after it. Fixed by keying
   every field to what it *is*, not its position.
4. The edit form defaulted `kind` to `'existing'` whenever `initial` was
   set (so it wouldn't re-ask "new or existing?"), but that same default
   silently made the opening-balance/date fields reappear on every edit
   regardless of how the pot was actually created.
5. `buildExampleLedger`'s "on £X balance" label interpolated a raw,
   unrounded float straight into the UI — a genuine floating-point
   artifact (`£1007.3599999999999`), not a formatting setting; every
   other figure already went through `formatCurrency` correctly.
6. `projectedBalanceAt` only ever summed freshly-*generated* recurring
   deposits and interest — it never looked at real, already-logged
   transactions at all, so a real manual deposit or withdrawal dated in
   the future was invisible to every projection built on it (the hero
   card's "Projected" figure, the pie-chart's projected%, the pot
   detail's now-removed cycle-end row).
7. The hero card's "Projected · Next 3 cycles" row was correctly
   *labelled* but always computed the *this-cycle* figure regardless of
   which horizon pill was selected.
8. The horizon pill (This cycle/Next 3 cycles) was hard-gated to only
   `personal`/`household` deck entries — written before savings pots (or
   joint/credit-card hero treatment) existed, and never revisited when
   new deck kinds were added.
9. The pause/resume design went through two full redesigns before
   landing — an initial from/until WINDOW model, corrected to a flat
   multi-select of individual dates reusing the ordinary
   `recurringDepositOverrides.deleted` mechanism Pension already had.
10. The pot's own ledger list and pie-chart ring didn't respond to the
    horizon pill at all — a fixed lookback window and a static
    percent with no projected% — where every comparable ring elsewhere
    (loans in `ProgressRingsSection`) has always shown a genuine
    current-vs-projected pair.

**Lessons learnt — for whoever picks up the next feature that touches
multiple existing consumers:**

- **A new generator needs to be wired into EVERY consumption point, not
  the first one found.** This app has (at least) two: `computeProjection`
  (what the Home page *displays* as pending) and `autoClearDuePayments`
  (what actually gets *materialized* when due). Bug #1 above is what
  happens when only one gets the new generator. When adding a new
  recurring/generated concept, grep for every existing generator's name
  (`generateSalaryTransactions`, `generatePensionTransactions`, etc.) and
  add the new one everywhere an existing one already appears — don't
  assume one call site is representative of all of them.
- **A new deck-entry kind needs every shared `entry.kind`-gated toggle
  re-audited, not just the ones that obviously apply.** `showHorizon`
  was written when only two kinds existed and nobody revisited it when
  four more were added over two sessions. Grep for `entry.kind` across
  the whole page when adding a kind, not just the places that seem
  relevant to the new feature.
- **Copy the WHOLE established pattern, not the part that looks right at
  a glance.** `ProgressRingsSection`'s loan rings have always shown
  current% AND projected% together; the pot's ring was built with only
  current%, which compiled fine, looked plausible in review, and was
  simply incomplete. When mirroring an existing UI pattern, diff against
  the actual precedent's code, not a memory of what it roughly does.
- **Any form with conditionally-shown/hidden sibling fields needs
  explicit `key`s from the start**, not added reactively after a bug
  report. This is cheap to do up front and expensive to diagnose after
  the fact (bug #3 took real interaction-testing infrastructure —
  `@testing-library/react` — to even investigate, and still couldn't be
  conclusively reproduced against the exact trigger).
- **A projection/derived-value function's signature should make it
  obvious what it actually uses.** `projectedBalanceAt` took a
  `currentBalance` parameter that the original implementation silently
  ignored in favour of recomputing from the pot's own opening balance —
  which is correct for every real caller (who always derives
  `currentBalance` from the same pot) but made the bug easy to miss in
  review and easy to get wrong in a hastily-written test.
- **Validate a "this should show X" claim against CURRENT live data, not
  a point-in-time backup or fixture**, especially in a multi-session
  working relationship where the person's real data keeps moving. Get
  this wrong and you don't just miss the bug — you actively erode trust
  by asserting something confidently that turns out to be checked
  against stale input.
- **Debugging aids added mid-investigation need an explicit removal
  step**, not just an implicit "someone will notice it's still there."
  It should have been proposed as a temporary, session-scoped tool from
  the moment it was added, with removal as an explicit line item once
  the bug was confirmed fixed — not left for Adam to have to ask for.

**What's actually done, for the record:** SavingsPot as its own deck
entry (hero card + detail), two interest methods (AER-credited,
daily-accrual-monthly-credited) with a save-time worked-example
explanation, monthly recurring deposits with a flat multi-select
pause mechanism, manual deposit/withdrawal logging from the Transactions
page, an info-icon ledger modal matching CreditCardLedgerModal's
pattern, two independent goal triggers (pie-chart ring for
targetAmount, info label for targetDate), and the pot's own ledger/ring
now genuinely responding to the This-cycle/Next-3-cycles horizon pill
the same way every other card's does. Test coverage: `scripts/verify-
savings-pots.ts` (49 checks), `scripts/verify-backup-savings-
simulation.ts` (validated against Adam's real household backup), and
`src/pages/SavingsPotForm.test.tsx` (3 real-DOM interaction tests, kept
permanently — `npm test`).

---

### b. Salary end date ✅ DONE (2026-09-02 session)

**Current state** (`types/models.ts` `Person['salary']`, `Salary.tsx`):
one salary shape per person, no end date.

**Requested:** a new date-picker field at the bottom of the salary card,
empty by default, clearable back to null. Setting it makes that date the
final salary payment — no salary payments generate after it. Two
realistic reasons someone sets this: a new job with different accounting
periods (needs a new salary entry alongside the ended one), or retiring
onto a pension (see item c). Either way, the summary-page ledger must be
unaffected for anything already cleared (today or earlier) — only future
projected payments stop.

**Built:** `SalarySnapshot.endDate?: string`. `findApplicableSnapshot`
returns `null` once past a snapshot's own `endDate` (a later snapshot,
if one exists, still wins independently). `computeNetPayForPeriod` gates
on this *before* checking a manual override — a stale override/bonus for
a period past the end date is suppressed too, not just the derived
figure. `latestSalarySnapshot` (a deliberately separate lookup from
`findApplicableSnapshot`) finds the governing snapshot even once it's
ended, so the end-date field itself stays editable/clearable afterward.
Also landed in the same pass: the Wallet page (renamed from "Salary")
restructured into type-grouped, always-visible, collapsible sections —
see the session-log section below for the full shape, since it kept
evolving through items c/f's own work too.

**Schema implication:** `salary_history` needs an `end_date` column
(nullable date). No other change to that table from this item.

### c. Pension income ✅ DONE (2026-09-02 session)

**Current state:** no concept of a second income type at all.

**Requested:** the "+" New Salary button gains a type selector (Salary
vs. Pension). A pension needs a name (most people have both a state and
a private pension, each with their own payment dates/rules), a net
amount, and a fully flexible frequency (state pensions are typically
weekly, private pensions vary by provider) — deliberately simpler than a
salary's shape, since PAYE/student-loan fields likely don't apply.
Pensions are treated as income exactly like salary, visible in the
summary page the same way.

**Real complications flagged by Adam — all resolved this session:**
1. **Sort order.** Partially resolved: `sameDateRank`/`computeCycleSummary`
   (`cycleSummary.ts`) now count `pension_income` alongside `salary`/`bonus`
   for both same-day ranking and the income subtotal — the correctness gap
   (pension income silently undercounted) is fixed. The deeper "which
   income source ranks first against ANOTHER income source on the same
   day" question is still genuinely open, flagged in that file's own
   comment, for whenever it actually matters (two income sources landing
   the literal same date).
2. **Multi-account-period following — fully resolved, including a
   correctness gap found and fixed mid-session.** See "Cycle-boundary
   following" in the session log below — this was the single biggest
   piece of work in this session, bigger than Pension itself.
3. **Salary deletion.** Resolved as suggested: `removeAllSalaryHistory`
   (a NEW action, distinct from ending a salary via item b's end-date
   field) converts already-cleared `'salary'` transactions to plain
   `'income'` via `convertClearedSalaryToStandaloneIncome`, then clears
   `salaryHistory`/`salaryOverrides`. Reachable via a 2-tap-confirm
   control in the pay-cycle settings modal.

Pensions get the same "next N upcoming payments as editable pills"
treatment already used for salary/recurring items (single-row or
all-future edit) — `pensionOccurrencePreviews`/`occurrenceOverrides`,
mirroring `schedule.ts`'s `RecurringTemplate` pattern exactly (own
implementation, not a shared one — see that file's own header comment
for why genericizing `schedule.ts` itself wasn't the right call).

**Superseded from the original framing above, via the household-
ownership design conversation this session:** Pension is **NOT** an
`income_type` discriminator on `salary_history`, and **NOT** nested
under `Person` the way salary is. It's its own **top-level, explicitly-
OWNED entity** (`personId`, set once at creation, freely reassignable
after) — architecturally identical to `Loan`/`CreditCard`, not to
`SalarySnapshot`. See "Household ownership model" in the session log
below for the full reasoning; this is the single most consequential
architecture decision from this session and changes this item's own
schema implication completely.

**Schema implication:** a genuinely new `pensions` table — `id`,
`person_id` (FK, like `loans.owner_id`), `name`, `amount`,
`frequency`/`interval_weeks`/`anchor_date` (same shape as
`recurring_templates`' scheduling columns), `active`,
`adjust_for_non_working_day`, `cycle_start_follows_payday`,
`amount_effective_from` + a `pension_amount_history` child table (same
normalization treatment as `salary_history`'s own historized fields, per
this doc's already-confirmed "historized fields normalize into
relational tables" decision), and an `occurrence_overrides` child table
(same shape `recurring_templates` will need for its own per-occurrence
edits). `transactions.type` gains `'pension_income'`, and `sourceType`
gains `'pension'`. `pay_cycles` gains `follows_income_source` (nullable
— `{type: 'salary'}` or `{type: 'pension', pension_id}`; a `jsonb`
column or two nullable columns, either works — the app-side type is a
discriminated union, see `types/ledger.ts`).

### d. What-if scenario — loan action timing + reduce-term math 🔜 NEXT UP — prompt below

**Before treating the "Requested" section below as ready to build
against as-is: confirm it's still current.** It reads as genuinely more
concrete than item f's did going into this session — Adam's own worked
examples are kept verbatim below specifically so the exact ordering
logic doesn't need re-deriving — but f-addendum's own lesson applies
here too: a written-out item can look settled and still have moved on
since it was last touched, especially across a session gap. Confirm
before assuming, don't skip the check just because this one reads well.

**Relevant addenda to read first, and why:**
- **a-addendum** — five general lessons about touching multiple existing
  consumers at once (wire a new generator into every consumption point,
  not just the first one found; re-audit every `entry.kind` gate when
  adding scope; copy the WHOLE established pattern, not the part that
  looks right at a glance; key conditionally-shown form fields
  explicitly; validate against current live data, not a stale fixture).
  Directly relevant here: reusing the Loans page's own amortisation
  functions (per the "Requested" section below) means touching an
  existing, heavily-consumed calculation path — the same failure mode
  a-addendum's bugs came from.
- **f-addendum** — the specific lesson that a backlog item reading as
  concrete doesn't mean it's buildable as written; confirm scope by
  asking, even where nothing is explicitly flagged open. Also has the
  `git stash`-isolation technique for checking whether a test failure is
  yours, which held up as broadly useful this session.


**Current state** (`types/models.ts` `Scenario['actions']`,
`Scenarios.tsx`): loan-targeting actions (`pay_off_loan`,
`loan_overpayment`) have no date field, no `reduceTerm` vs.
`reduceMonthly` toggle, no projected new end-date output.

**Requested:**
- A date field on loan lump-sum/overpayment actions — when it actually
  happens, not "eventually."
- For a lump sum specifically: toggle between reduce-monthly-payment and
  reduce-term — genuinely different amortisation outcomes, touching the
  real payoff math in `lib/loans.ts`/`ledgerLoans.ts`, not a display
  difference.
- The combined-scenarios summary card's display rules depend on *every*
  action's choice, not just one: hide "available now/after per month" if
  no action in the combination chose reduce-monthly; hide "time saved" if
  every action chose reduce-monthly. Mixed combinations show both.
- Recurring overpayments never get the reduce-monthly option — that
  usually requires actually calling the lender, unlike a lump sum.
- Show an estimated new end date below "time saved" whenever at least one
  action in the combination chose reduce-term.
- **Action ordering is date-driven, not creation-order-driven** — two
  scenarios (or two actions within one scenario) that specify the same
  dates must produce identical results regardless of which was created
  first or whether they're split across scenarios or combined into one.
  Adam's own worked examples (kept verbatim, since the exact ordering
  logic matters):

  > **Scenario 1**
  > 1. A £500 lump sum against a loan with a £2000 balance, dated
  >    tomorrow (2026-09-02), reduce-monthly selected.
  > 2. A separate scenario: £100/month recurring overpayment starting
  >    2026-09-14.
  >
  > *Result:* the lump sum reduces both capital and interest first,
  > resetting the monthly payment (reuse the loans page's own
  > calculation logic). Then the £100/month overpayments apply from the
  > 14th — all overpayments of any kind repay capital only, never
  > interest, so the loan re-amortises from there (again, reuse the
  > loans page's logic).
  >
  > **Scenario 2** — same two actions, but both added to *one* scenario,
  > with the overpayment action added first and the lump sum second.
  >
  > *Result:* must be identical to Scenario 1's — the dates (2026-09-02,
  > 2026-09-14) determine order, not creation sequence or which
  > scenario an action lives in.

- If a loan action's math can reuse the same calculation functions the
  Loans page itself uses for real overpayments, prefer that over a
  parallel implementation — same amortisation engine, not two.

**Schema implication:** none directly — `scenarios` is already a
placeholder `jsonb` table for exactly this reason (shape unknown until
the feature exists). This is the concrete work that resolves that
placeholder.

### e. Credit card accounting periods

**Current state:** no accounting-period concept on credit cards at all —
presumably a simple running balance + minimum payment today.

**Requested:** accounting start/end dates as a day-of-month picker (1st,
2nd, 3rd, ... — not a full date picker, needs parsing against whichever
month it falls in), plus the real-world behavior Adam described from a
non-cardholder's understanding (worth confirming with someone who
actually uses one before building, per Adam's own caveat that he's
unsure of the exact mechanics): a transaction made during one statement
window doesn't affect the *minimum payment due* until the payment date
tied to the window it actually falls in, even though it immediately
affects the running balance. E.g. statement window 19th–18th, payment
due 14th of the following-plus-one month — a transaction on the 25th
increases the balance immediately, but doesn't hit the minimum-payment
calculation until the payment window it's actually billed in.

**Deliberately deferred from earlier development** due to this
complexity — this is the session to actually build it.

**Schema implication:** `credit_cards` likely needs statement
start-day/end-day columns; the payment-window logic itself is
application logic, not a schema question, but may need a `billing_cycle`
or similar table if lump payments need to be tracked per-window rather
than just per-date.

### f. Joint/household summary page — full review ✅ DONE (2026-09-03 session, substantially rescoped from what's below — see f-addendum)

**Current state** (`lib/jointLedger.ts`): `computeJointSummary()` and
`generateJointContributionTransactions()` produce **synthetic** per-person
share figures for projection purposes — genuinely useful for forward-
looking numbers, but the file's own header already flags the limitation
Adam's describing: joint splitting only supports exactly two people
(payee + "the other one"), and **no real cleared ledger `Transaction`
rows show up in the household view at all**, only the synthetic
projected shares.

**Requested:** a full review, not a patch — the household view needs its
own query against real transactions filtered to `location: 'joint'`,
shown *alongside* (not instead of) the existing projected figures,
covering both accounts' salary payments and bills. Same multi-account-
period problem as item c applies here too — Adam's specified resolution
for this page specifically: use whichever salary/pension is currently
"Set as me" when more than one exists.

**Built so far — the data layer:** `jointLedger.ts` gained
`householdRealActivity(data, rangeStart, rangeEnd)` — queries
`data.transactions` directly (not generated) for every `location:
'joint'` transaction plus every household member's own
`'salary'`/`'pension_income'` transaction, cleared AND pending both (the
synthetic functions above only ever produce forward-looking
occurrences; this list's whole point is to show what's real). Window
resolved via `resolveCycleBounds(data, primaryPersonId, ...)` — item c's
cycle-following work, so this genuinely was the blocking dependency it
looked like. Wired into BOTH cards as a flat list, deliberately split by
scope rather than merged into one:
- **Joint card** (`JointDetail`) — real joint-only activity (the literal
  `location: 'joint'` filter), single cycle, below the existing synthetic
  list.
- **Household card** (`HouseholdDetail`) — the full combined view (joint
  + both people's income), spanning the selected horizon, below the
  existing per-person balance summary.

**⚠️ Addendum, 2026-09-02 (later same day) — the actual intended scope
is bigger than what's built.** Adam's clarification: the review was
always meant to make the household view work **the same way the
individual Personal summary ledger already does** — Group by
(category/list)/Order by (date/amount), the cycle-end totals toggle, the
show-cleared toggle, the running-balance fold — see `PersonalDetail` in
`Home.tsx` for the full feature set this needs to match. What's built so
far (`householdRealActivity` + the flat lists above) is the right DATA
layer underneath this — it already returns real, itemized, cleared/
pending transactions rather than synthetic ones — but it's currently
rendered as a bare list with none of those controls, not genuinely
ledger-parity yet.

**Still needed:**
- The household transaction list needs the same `CategoryGroupedList`/
  `AmountOrderedList`/`CycleGroupedList`/`DateOrderedList` treatment
  `PersonalDetail` already has, fed by `householdRealActivity`'s output
  (or a close variant of it) instead of `projection.transactions` — the
  four existing list components are keyed to a single person's
  transactions/`data`, so they likely need a household-aware variant or
  a light generalization, not a full rewrite.
- This Cycle / Next 3 Cycles need to filter the transactions like they      currently do, and also affect any pie chart projections.
- Group by/Order by/Cycle-end totals/Show cleared controls (`DeckControls`
  in `Home.tsx`) need to actually apply to the Household/Joint cards —
  currently `showGroupOrder = entry.kind === 'personal'` restricts those
  controls to the Personal card only; that gate needs revisiting for
  `'household'` (and possibly `'joint'`).
- Add the option here to group by person, with the same options to follow (order by amount or date, include cycle-end totals, and include/exclude cleared).
- Running balance for the household view specifically needs its own
  definition — decide whether it's the sum of both people's opening
  balances folded against the SAME combined transaction list, or kept
  as two parallel per-person folds shown together. Not resolved yet;
  flag before building rather than picking a default silently.

**This item is not closed** — reopened from its earlier "done" marking
until the addendum above is built. Whichever session picks this up
should treat `householdRealActivity` as a confirmed-good starting point,
not something to redo.

**Verification:** `scripts/verify-household-real-activity.ts` (9 checks:
in-range/out-of-range filtering, cleared+pending inclusion, correct
person-name tagging, a dangling `personId` handled safely, chronological
sort). Also smoke-tested directly against Adam's real backup — 0 rows in
his current window, which is correct (no joint bills configured yet, no
real income transaction materialized for that exact window at export
time), not a bug.

**Schema implication:** none new — this is a `transactions` table
querying/display problem in the app, not a missing column, exactly as
originally scoped.

### f-addendum. Full rebuild session (2026-09-03) — confirmed scope, then designed, then built — final status

**Status: ✅ done and stable.** Everything below this section's original
text (including its own 2026-09-02 addendum) is kept as the historical
record of how the item was originally scoped — but the actual final
design diverged from it substantially, on Adam's own direct correction,
partway through this session. Whoever reads this doc next should treat
**this addendum**, not the text above it, as the authoritative
description of what the Household/Joint cards actually do now.

**Phase 1 — confirming what to build.** The migration plan's own item f
text above *read* as concrete (it has a "Requested" section, a "Still
needed" checklist, even one explicitly-flagged open question about the
running balance) — but it wasn't actually buildable as written. Working
through it surfaced real gaps the checklist didn't anticipate:
- The checklist's own open question (combined vs. per-person running
  balance) turned out to have a THIRD answer once actually asked:
  conditional on the grouping mode, not a single fixed choice — combined
  when ungrouped, per-person when grouped by person.
- "Group by person" (in the checklist) implied joint bills would need to
  be attributed to a specific person's bucket somehow — asking surfaced
  that they shouldn't be attributed to a person AT ALL; Adam's correction
  was that the joint account should be treated as **its own account**,
  not split.
- That correction cascaded further once discussed: the Household card
  shouldn't show joint bills in ANY form (not even in their own bucket)
  — it's a summary of each person's own personal picture, full stop. The
  joint account's own real activity belongs entirely on the Joint card.
- A genuinely new requirement emerged that isn't in the checklist at
  all: a real joint-account entity with its own opening balance/date
  (nothing in the schema modelled this — joint bills were cost-split
  constructs, not an account), a non-optional first-time setup flow, and
  a new deposit/withdrawal transaction type/UI so money moving between a
  person's own account and the joint one is trackable at all.
- Progress-ring scope also needed confirming directly — not in the
  original checklist — resolved as: Household shows personal loans
  across every household member (not just the viewer, unlike Personal's
  own ring); Joint shows joint-location loans; each card's rings stay
  strictly scoped to what that card is actually about, mirroring the
  same split the balance data itself now has.

None of this was a failure of the original spec-writing — the checklist
was a reasonable, honest snapshot of what was known at the time it was
written. The lesson is really about **when** to trust a written-out item
as buildable: see "Lessons learnt" below.

**Phase 2 — design and build, once scope was confirmed:**
- **`lib/householdLedger.ts`** (new) — the Household card's real data
  layer. `computeHouseholdPersonProjection`/`computeHouseholdProjections`
  reuse `computeProjection`'s real+generated blend per person (the exact
  same numbers their own Personal card shows), then strip out any
  synthetic joint-bill-share row by tracing `sourceId` back to a
  joint-location `RecurringTemplate`/`Loan` — the one reliable marker,
  since `generateJointContributionTransactions` (`jointLedger.ts`) is the
  only generator that produces these. Recomputes `clearedBalance`/
  `projectedBalance` from the filtered set rather than trusting
  `computeProjection`'s own figures, so the card's hero and its own list
  can never disagree.
- **`lib/jointAccountLedger.ts`** (new) — the Joint card's real data
  layer, genuinely separate from the above. `JointAccountConfig`
  (`openingBalance`/`openingBalanceDate`, same anchor-pairing idea as
  `CreditCard`'s `currentBalance`/`balanceAsOfDate`) lives on
  `AppDataV2.jointAccount`, null until first needed.
  `needsJointAccountSetup(data)` is true the moment ANY joint-location
  bill/loan exists with no `jointAccount` yet — checked globally (see
  below), not per-form, so Bills.tsx/Loans.tsx needed **zero** changes.
  `computeJointAccountProjection` folds real+generated joint bill/loan
  occurrences plus real `joint_deposit`/`joint_withdrawal` transactions
  against the opening balance, using `jointAccountSignedAmount` — a
  type-derived sign specific to the joint account's OWN ledger (a
  deposit is positive here despite being an 'out' on the depositing
  person's personal ledger; same "type decides sign on THIS ledger"
  pattern as `credit_card_spend`/`savings_deposit` elsewhere).
- **Two new `TransactionType`s** — `joint_deposit`/`joint_withdrawal`.
  Deliberately ordinary `location: 'personal'` rows on whichever person
  made the transfer (so `computeProjection`/`isLedgerTransaction` need
  no special-casing at all), read with the opposite sign on the joint
  account's own ledger via the function above. These are the ONLY
  joint-account-related items that appear on the Household card.
- **`components/JointAccountSetupModal.tsx` + `AppGuards.tsx`** (new) —
  the non-dismissable first-time setup flow, wired once at the app root
  (`App.tsx`) rather than into every place a joint bill/loan could be
  created. Reused in a dismissable "edit" mode from the Wallet page's
  new Joint Account section.
- **`pages/Home.tsx`** — the actual ledger-parity UI: `HouseholdDetail`
  (List/Category/Person grouping — Person groups each household member's
  own real+generated personal activity with their own running balance;
  ungrouped views fold everyone's personal activity into one combined
  running balance in date order) and `JointDetail` (the existing
  synthetic per-person split kept exactly as it was, with the new real
  ledger — same List/Category/Order/Cycle-totals/Show-cleared controls —
  added below it, not replacing it). `DeckControls`/`canShowCycleTotals`
  widened from Personal-only to Household+Joint. The four existing list
  components (`CategoryGroupedList`/`AmountOrderedList`/
  `CycleGroupedList`/`DateOrderedList`) gained an optional `amountSign`
  override rather than being forked — the Joint account is the only
  context that needs the flipped sign, so every other call site is
  unaffected by the change.
- **Transactions page (`Expenses.tsx`)** — new "Joint" pill (Deposit/
  Withdraw, person-picker, same shape as the existing Savings pill),
  plus a full UX pass across all three transaction-list pills
  (Transactions/Savings/Joint — deliberately NOT Recurring, which shows
  templates with no cleared/pending status to group by): tap-to-expand-
  edit + swipe-to-delete brought to Savings/Joint (previously missing
  entirely) and upgraded on the main Transactions pill (previously a
  static trash-icon click, not a real swipe); cleared entries now
  collapse into one card per calendar month (collapsed by default,
  pending stays a flat list exactly as before) via one new generic
  `MonthCollapsedTransactionList` component shared across all three;
  Savings/Joint's edit form gained a pot/person picker respectively,
  invisible with only one option, matching the CREATE form's own
  "silently bind vs. picker" rule — editing which person made a joint
  transfer moves `ownerId` alongside `personId`, since the two drifting
  apart would silently drop the entry off everyone's Personal/Household
  card rather than actually move it.

**A real regression risk, checked and ruled out:** making
`AppDataV2.jointAccount` a required (non-optional) field could have
broken every existing `scripts/verify-*.ts` fixture that builds an
`AppDataV2` literal without it. Checked directly rather than assumed
fine: `scripts/` isn't covered by either `tsconfig.app.json` or
`tsconfig.node.json` (only `src` and `vite.config.ts` are), so `tsx`
transpiles each script standalone without cross-file type-checking —
existing fixtures run exactly as before. Confirmed by actually running
the **entire** existing `verify-*.ts` suite (50+ scripts, including
`verify-backup-savings-simulation.ts` against Adam's real household
backup) before and after this session's changes, isolating the diff via
`git stash` to separate this session's edits from Adam's own
already-uncommitted work in the same working tree.

**Pre-existing failure found, not caused by this session — flagged, not
fixed:** `scripts/verify-purchase-scenario.ts` has 3 failing checks
(`cycleStartFollowsPayday` cycle bounds returning the fixed-day boundary
instead of the payday-following one). Confirmed pre-existing by testing
against Adam's own working tree with only this session's files removed
— the failure persisted. Not touched this session; worth a dedicated
look before or during whichever session next touches cycle-boundary
math. Two further scripts (`verify-cycle-end-totals.ts`,
`verify-overpayment-independence.ts`) fail only because
`scripts/fixtures/backup-2026-08-24.json` wasn't present in the uploaded
codebase (gitignored contents) — an environment gap, not a code issue.

**Lessons learnt:**
- **A written-out backlog item can look concrete and still not be
  buildable as written** — this one had a "Requested" section, a "Still
  needed" checklist, and one explicitly-flagged open question, and STILL
  needed real back-and-forth before code could start, because the
  checklist's own assumptions (joint bills attributable to a person;
  Household continuing to show joint content in some form) turned out to
  be wrong once actually asked. Confirm current intent before building
  against ANY backlog item here, even ones that read as fully specified
  — especially across a session gap, where intent may have moved on from
  what got written down.
- **Ask before building when a spec has an explicit open question, but
  also ask when it doesn't** — the doc flagged the running-balance
  question explicitly and that was right to stop on, but the bigger
  correction (Household excluding joint bills entirely) came from a
  question about something the checklist treated as already-settled.
  Don't limit clarifying questions to what's already marked uncertain.
- **A required-field schema change needs its blast radius checked, not
  assumed** — `AppDataV2.jointAccount` being non-optional was safe here
  specifically because `scripts/` sits outside both tsconfig projects;
  that's a fact about THIS repo's setup, not something to assume holds
  elsewhere. Check `tsc -b`'s actual include scope before trusting a
  clean build as proof nothing broke.
- **When testing "is this regression mine," isolate via git, don't
  guess.** A blind `git stash`/`stash pop` across the whole working tree
  nearly produced a false negative here (it reverted Adam's own
  pre-existing uncommitted work too, not just this session's changes) —
  `git stash push -- <specific files>` to isolate exactly this session's
  edits was the fix, and is the right general technique whenever a
  working tree already has other legitimate uncommitted changes in it.

**What's actually done, for the record:** Household card shows each
person's own personal-only activity (income, personal bills/loans/
ad-hoc, joint account deposits/withdrawals), List/Category/Person
grouping, per-person or combined running balance depending on grouping,
personal-loans-only progress rings across every household member. Joint
card keeps its existing synthetic per-person split and gains a full real
ledger below it (same controls as Personal), joint-loans-only progress
rings, and a genuine reconciled opening balance. New joint account setup
flow (non-dismissable on first joint bill, editable afterward from
Wallet), new Transactions-page Joint pill, and a full interaction/UX
pass across every transaction-list pill on that page. Test coverage:
`scripts/verify-joint-account.ts` (14 checks against the real engine,
including a check that a person's OWN projection genuinely includes
their joint-bill share before confirming the Household filter strips it
back out — not just asserting the filter works, proving it removes
something real).

**File delivery this session:** four rounds, each a zip of only the
files that changed that round, real `src`/`scripts` paths — following
the convention set in the a-addendum above. Round 1: the core rebuild
(13 files, `types/ledger.ts` through `Home.tsx`). Round 2: Transactions
page swipe/tap/month-grouping UX pass (`Expenses.tsx` only). Round 3:
pot/person edit pickers (`Expenses.tsx` only).

---

### g. Auth/account UI — reuse inventory from `personal-finance` (for later, not this session)

**Not a backlog item — a pointer for whenever personal-finance-ledger's
auth/Supabase layer actually gets built**, since that's explicitly out of
scope for the feature-backlog work above. Recorded now, while both
codebases are already open, so it doesn't need re-discovering later.
`personal-finance` (the simpler app) is fully shipped with its auth layer
built against the same shared-identity model this project settled on, so
its components are a direct port candidate rather than a from-scratch
build:

- **`src/context/AuthContext.tsx`** — `session`/`authMode` state,
  Google OAuth + email/password sign-in, password reset, sign-out. Three-
  state `session` (`undefined` = not checked, `null` = signed out,
  `Session` = signed in) mirrors BLOC's own pattern.
- **`src/components/AuthGate.tsx`** — full-screen mandatory sign-in shown
  whenever `session === null`; OAuth buttons + Sign In/Sign Up tabs +
  email/password form + Forgot Password, same shape as BLOC's `#auth-gate`.
- **`src/components/AccountModal.tsx`** — identity + change-password +
  sign-out, opened from a profile icon. `isEmailPasswordAccount()`/
  `providerLabel()` (exported helpers) read `session.user.app_metadata.provider`
  to hide "Change password" for OAuth-only accounts. Scoped deliberately
  narrow in personal-finance (no GDPR export section built there yet) —
  ledger may want to extend it, not just port it verbatim.
- **`src/components/LinkHouseholdModal.tsx`** — the household link-code
  modal: show/generate this household's permanent code, "Regenerate"
  (calls `regenerate_household_link_code()`, deliberately separate from
  the idempotent "show code" path), and a join-by-code tab (calls
  `redeem_household_link_code()`). Directly reusable shape once ledger's
  own household-linking migration (see "Status & what's next" above,
  step 2) lands — same RPC names, same result shape
  (`brought_own_data`/`reparented_bills`/`reparented_loans`/etc.), just
  pointed at the ledger schema.

All four assume the same shared `auth.users` identity and the same RPC
contracts already decided for this project, so porting should mean
re-pointing schema/table references, not redesigning the flow. Nothing
here is being built this session — this is reference only for when the
migration work resumes.

---



| Your name | Schema | Storage bucket |
|---|---|---|
| personal-finance-ledger | `personal_finance_ledger` | `personal-finance-ledger-backups` |
| personal-finance | `personal_finance` | `personal-finance-backups` |
| my-dream-clean | `my_dream_clean` (empty — no tables) | `my-dream-clean-backups` |

---

## a. personal-finance-ledger

**Scope:** relational tables + snapshot backup. Full sync layer (the
`markSyncDirty`/`flushSyncQueue`/`pushStateToSupabase` pattern from
`TECHNICAL.md` §59) reused as architecture, rewritten against these tables.

17 tables total. Parent → child order matters for the sequential sync loop
(sync parents before children, per the §59 lesson):

`people` → `salary_history` → `salary_deductions`
`people` → `salary_overrides`
`people` → `savings_entries` *(best-guess shape)*
`categories` (no parent)
`categories`, `people` → `recurring_templates` → `recurring_template_amount_history`
`categories`, `people` → `loans` → `loan_overpayments`, `loan_statement_calibration_lines`
`categories`, `people` → `credit_cards` → `credit_card_lump_payments` *(best-guess shape)*, `credit_card_minimum_payment_overrides`
`categories`, `credit_cards`, `people` → `transactions`
`people` → `pay_cycles`
`scenarios` (no parent, placeholder shape)

Full column definitions: [`migrations/20260831120002_personal_finance_ledger.sql`](migrations/20260831120002_personal_finance_ledger.sql).

**Reused as-is from BLOC** (per the original doc's "fully reusable"
inventory): auth gate, `AUTH_PROVIDERS`/`renderAuthProviders`,
`initSupabaseAuth`/`onAuthResolved`, the whole email/OAuth sign-in flow
(*with the `emailRedirectTo` fix, not the original*), Change Password
modal, snapshot backup/restore mechanics, Export/Restore + Account & Data
modal shape.

**Rewritten per-app:** every `syncRows*()` function (17 tables' worth), RLS
policies (plain `auth.uid() = user_id`, no coach/client shape — this app has
no such concept), GDPR export/erasure function bodies (table list is
per-schema).

**Paused.** No app code written yet for this app — see "Status & what's
next" above. The tables above are live in Supabase, but expect the
`savings_entries`/`salary_history`/`scenarios` shapes to change once the
feature backlog is built, and expect a combined schema-revision +
household-linking migration to replace/extend `20260831120002` rather than
building sync code against the current shape now.

---

## b. personal-finance

> **✅ Phase 2 is done too.** The "explicitly out of scope" framing below
> was accurate when written; PowerSync and link-code household linking
> are now both fully built — see the resolution boxes above and
> `HANDOFF.md` for current state. Left the original scope note below for
> context on why phase 1 shaped the schema the way it did.

**Scope this document covers:** relational tables + snapshot backup only.
**Explicitly out of scope here, confirmed with you:** the PowerSync SDK
cross-device sync layer and the link-code household-linking mechanism. Both
are phase 2. What this document *does* do is shape the phase-1 schema so
phase 2 is additive — see the commented-out sketch at the bottom of
`20260831120003_personal_finance.sql` — rather than something you'd need to
re-migrate.

7 tables. Parent → child order:

`people` (salary flattened in, no history table — see note in the SQL file) → `salary_deductions`
`people` → `savings_entries` *(best-guess shape)*
`people` → `bills` (owner_id nullable FK; category is free text, not normalized)
`people` → `loans`
`scenarios` (placeholder shape)

Full column definitions: [`migrations/20260831120003_personal_finance.sql`](migrations/20260831120003_personal_finance.sql).

**One real gap to flag directly:** this app's backup has a single `salary`
object per person, not a `salaryHistory` array like the ledger app. That's
not a migration-time choice — it means the app itself doesn't currently
*track* salary changes over time, so there's nothing in the backup to
normalize into a history table. If you want salary history here to match
the ledger app, that's an app feature to build first (so a real backup
contains the history), then a follow-up migration to add the table — not
something I can add now without inventing data.

**When you're ready for phase 2** ~~(PowerSync + link codes) — see
"Cross-device household linking" below. It's no longer deferred: it's
designed in full there, and the infra migration for this app is written
and ready to run.~~ **✅ Done** — phase 2 is fully built, not just
designed. See the resolution box under "Cross-device household linking"
below, and `HANDOFF.md` for current state.

---

## Cross-device household linking — design (personal-finance-ledger & personal-finance)

One shared pattern, applied to both apps. **Live now for personal-finance**
(`20260831140000_personal_finance_household_linking.sql`, below).
**Designed here but not yet migrated for personal-finance-ledger** — it'll
ship combined with that app's feature-backlog schema revision (see "Status
& what's next" above for why), reusing the exact same table/function/RLS
shape documented here.

### What "linking" means here

Today, both apps model a couple by one person typing both salaries into
their own single local device (`AppData.people` holding two `Person`
entries, `primaryPersonId` marking which one is "you" on this device — see
`src/lib/storage.ts`/`AppContext.tsx`). Linking replaces that with: each
partner gets their own device and their own sign-in, a link code joins the
two accounts into a shared **household**, and household-scoped data
(people, bills, loans — see "What's shared vs. personal" below) becomes
visible and editable from either device, kept in sync by PowerSync.
`primaryPersonId` stays exactly what it is today — a per-device, purely
local value, never written to any Supabase table or PowerSync bucket (see
"What never syncs" below). It doesn't need excluding at the schema level;
it was never a column to begin with.

### Real design decision — RESOLVED for personal-finance

> **✅ Decided (Adam, this session): option 1 with a real mechanism behind
> it, not the silent-orphan version originally sketched.** The joining
> user's own salary and personal bills/loans **do** survive — carried
> across, not left behind — because of `linked_user_id`: a column on
> `people` tied to the real signed-in user (`auth.uid()`), settable only
> to yourself (trigger-enforced), which gives the redeem function
> something structurally reliable to identify "which row is genuinely
> this person" across two different households/devices, instead of
> matching on a name string. Full mechanism in
> `20260901150000_personal_finance_linked_user_merge.sql`. A likely
> duplicate left behind by the merge (e.g. a guess row the inviter had
> already typed in) is flagged for manual review (`DuplicatePersonBanner`
> in the app), never silently deleted.
>
> **For personal-finance-ledger:** design `linked_user_id` into the
> household-linking migration from the very start this time, not as a
> follow-up fix — see `MIGRATION-LESSONS.md` §5.

**What happens to a joining device's own existing local data?** Today,
before linking, each partner's device may already have its own People/
Bills/Loans typed in locally (the very thing linking is meant to replace).
When device B redeems a code generated by device A, three real options:

1. **B adopts A's household wholesale.** Whatever B already had locally
   before joining is left behind (not merged, not deleted — just no
   longer the source of truth once B is in A's household). Simplest to
   build, but silently orphans anything B typed in before linking if
   neither of you notices.
2. **A one-time merge screen on redeem.** B sees both datasets
   side-by-side and picks what to keep, person by person / bill by bill.
   Real UI work, but no silent data loss.
3. **Redeeming is blocked if B has any non-empty local data**, forcing an
   explicit "export your current data first, then redeem" step before
   linking — punts the merge problem to the export/import flow you
   already have, at the cost of an extra manual step.

The actual built mechanism is closest to a real-time, automatic version of
option 2 — not a manual side-by-side picker, but an automatic merge (own
salary + own personal bills/loans carried across via `linked_user_id`)
with a flagged-not-deleted duplicate for anything left ambiguous. See the
resolution box above.

### What's shared vs. personal, once linked

**Shared (household-scoped):** `people`, `bills`, `loans` — the "our
financial picture" data both partners should see and edit from either
device, matching the product goal.

**Stays personal (user-scoped, not shared):** `scenarios` — what-if
exploration reads as an individual's own sandbox, not something a partner
should see mid-thought or have overwritten. Worth confirming this is what
you want; easy to flip later, harder to un-flip after real scenario data
exists in either bucket.

**Never syncs at all:** `primaryPersonId` ("set as me") — pure local
state, per-device by design, as above.

### Schema — households, membership, link codes

Three new tables per app schema:

- **`households`** — just an id. No owner concept; membership is what
  matters.
- **`household_members`** — `(household_id, user_id)` pairs. A user has at
  most one row here today (single-household membership) — the redeem
  function enforces this by removing any prior membership before adding
  the new one, per whichever option above gets chosen.
- **`household_link_codes`** — short-lived (15 min), single-use codes.
  Deliberately has **no client-readable RLS policy at all** — a code is
  only ever validated by calling the redeem function below, never by a
  direct `select`, so an active code can't be enumerated or guessed via
  the API.

`people`/`bills`/`loans` each gain a `household_id` column. RLS on those
three moves from "auth.uid() = user_id" to "your household membership
includes this row's household_id" — the actual sharing mechanism.
`user_id` stays on every row (audit/attribution — "who logged this"), it
just stops being what access control checks.

### The link-code flow

> **⚠️ SUPERSEDED (permanent codes, not 15-minute single-use)** — the
> steps below describe the *original* design. Adam changed this
> explicitly: link codes are now **permanent and reusable**, generated
> once per household and returned unchanged on repeat requests
> (idempotent `create_household_link_code()`), with a separate
> `regenerate_household_link_code()` as the deliberate "this leaked, kill
> it" action — never automatic, never silently rotated. See
> `20260901150000_personal_finance_linked_user_merge.sql` for the real
> version. Steps 1–4 below are otherwise still accurate in shape (generate
> → share → redeem → both devices see each other), just without the
> expiry/single-use constraint.

1. Device A (signed in) taps "Generate Link Code". Calls
   `create_household_link_code()` — creates a household for A if they
   don't have one yet (via `ensure_household()`), generates an
   8-character code (unambiguous alphabet, no `0/O/1/I`) the first time,
   or returns the household's existing code if one was already generated.
2. A shares the code with B, any channel — text, in person, however.
3. Device B (signed in, on their own account) enters the code. Calls
   `redeem_household_link_code(code)` — validates it exists, captures B's
   current household *before* moving membership (critical — RLS hides it
   immediately after), moves B into A's household, and runs the merge
   described in "Real design decision" above.
4. Both devices are now in the same household. RLS means both immediately
   see each other's household-scoped rows the next time either queries —
   PowerSync is what makes that feel live rather than requiring a manual
   refresh.

Both functions are `security definer`, callable only by `authenticated`
(never `PUBLIC`) — same GRANT discipline as the GDPR functions from the
original BLOC pattern.

### PowerSync — ✅ built and wired, not just designed

> The section below describes the *original plan*, written before
> PowerSync was actually built. Real terminology and mechanism differ in
> places (PowerSync's product terminology moved from "sync rules YAML" to
> "Sync Streams" between when this was written and when it was built).
> **For the actual, current, verified setup steps, read
> `POWERSYNC-SETUP.md` in full** — it has the real SQL, the real Sync
> Streams YAML, the real client architecture (six files under
> `src/lib/powersync/` plus the `AppContext` rewrite), and every gotcha
> found building it. The bullets below are kept for the original
> reasoning, not as instructions to follow.

This needs its own PowerSync project before any client code can be
written against it — same relationship the Supabase project itself had to
this document before you'd created it. Once you have one:

- **Publication:** Supabase's Postgres needs a logical-replication
  publication covering `people`/`bills`/`loans` (and `household_members`,
  so a client can resolve its own household) in each app's schema —
  PowerSync's own Supabase integration guide covers the exact `CREATE
  PUBLICATION` statement; happy to write it once you're at that step.
- **Sync rules** (YAML, hosted in the PowerSync project): one bucket
  definition parameterised by `household_id`, resolved via a
  `household_members` lookup keyed on `request.user_id()` — every row a
  device pulls is scoped to its household automatically, so a device
  never has to ask "whose data is this" client-side.
- **Client SDK:** `@powersync/web` (WASM SQLite) alongside the existing
  Supabase JS client — Supabase stays the source of truth and auth
  provider; PowerSync layers a local, offline-capable, live-synced replica
  of the household-scoped tables on top, with writes queued locally and
  pushed back through a connector.
- **Pull-to-refresh:** PowerSync is realtime-streaming by design (a
  websocket, not a poll), so in normal operation a partner's edit already
  shows up without any manual action. A pull-to-refresh gesture still
  earns its place as a confidence affordance — call `powersync.connect()`
  (safe to call when already connected) and flush any queued local writes,
  show a brief "Synced" confirmation on completion. It's reassurance more
  than a functional requirement, which is worth knowing going in so it
  doesn't get over-built.

None of this is written into either app yet — this is the design to build
against once the PowerSync project exists and (for personal-finance-ledger)
once the feature backlog above is done.

---

## c. my-dream-clean

**Scope:** snapshot backup only, no relational tables, per your
requirements. Nothing in `clients`/`appointments`/`settings` needs its own
table for this scope — the whole app state round-trips through one JSON
snapshot, same mechanism as the other two apps' backup path.

Its bucket and RLS policies are already created in
[`migrations/20260831120001_shared_baseline.sql`](migrations/20260831120001_shared_baseline.sql)
(the `my-dream-clean-backups` block) — no dedicated migration file for this
app, since there are no tables to create. The `my_dream_clean` Postgres
schema is created empty for consistency with the other two, in case a
relational table becomes wanted later.

---

## Migration file order

Run these against the Supabase SQL editor (or via CLI/CI, per
`PROJECT-SETUP-INSTRUCTIONS.md`) in this order:

1. `migrations/20260831120001_shared_baseline.sql`
2. `migrations/20260831120002_personal_finance_ledger.sql`
3. `migrations/20260831120003_personal_finance.sql`
4. `migrations/20260831130000_fix_profiles_grants.sql` — follow-up, fixes a
   missing `UPDATE` grant on `public.profiles` found after checking actual
   grants post-deploy.
5. `migrations/20260831140000_personal_finance_household_linking.sql` —
   households/membership/link-codes for `personal_finance`, original
   15-minute-expiry/single-use design — **superseded by #6**, kept
   because #6 builds on top of it (`CREATE OR REPLACE`/`ALTER TABLE`
   against what this one created), not a standalone step to skip.
6. `migrations/20260901150000_personal_finance_linked_user_merge.sql` —
   `linked_user_id` + self-link trigger, RLS fix for
   `salary_deductions`/`savings_entries`, permanent/reusable link codes
   (`create_household_link_code()` made idempotent,
   `regenerate_household_link_code()` added), merge-aware
   `redeem_household_link_code()`. **The real household-linking behavior
   — read this file's own header comment for the full reasoning.**
7. `migrations/20260902090000_personal_finance_ensure_household.sql` —
   `ensure_household()`, closing a real gap: a solo user who never
   generated a link code had no household at all, and their first bill
   would've hit a null-constraint failure.
8. `migrations/20260902093000_personal_finance_fix_savings_entries.sql` —
   corrected `savings_entries` to match the app's real `SavingsEntry`
   type (the original, in #3, was an explicitly-flagged guess that turned
   out wrong); dropped the now-dead `people.savings_goal_*` columns.

**No equivalent #5–8 exist yet for `personal_finance_ledger`** —
deliberately held until that app's feature-backlog schema revision is
ready, so it ships in one combined migration incorporating everything
learned building personal-finance's version, rather than replaying the
same superseded-then-fixed sequence again. See "Status & what's next"
above for the concrete replay order once that backlog is done.

Commit and push each new one to `supabase/migrations/` like the last —
the GitHub integration only runs files it hasn't seen before, and
**verify the push actually succeeded** — `MIGRATION-LESSONS.md` §14 has a
real case this session of a migration silently never having been applied
despite being fully written and delivered.

Then follow `PROJECT-SETUP-INSTRUCTIONS.md` for the dashboard-only steps
(exposed schemas, auth providers, Site URL/Redirect URLs per app) that no
SQL migration can do for you, and `POWERSYNC-SETUP.md` for the PowerSync
side once the schema's stable.
