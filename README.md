# Personal Ledger — offline personal finance PWA

> A single-device, offline-first Progressive Web App for running a real household's money: net
> salary (UK PAYE), bills and recurring transactions, loans with a genuine amortisation engine,
> credit cards with real interest, pots and savings pots, a joint account, transfers, round-ups,
> and what-if modelling. **No backend, no sync, no auth — deliberately and permanently.**
> Everything lives in one `localStorage` key on the device.

![Stack](https://img.shields.io/badge/stack-Vite%20%C2%B7%20React%2019%20%C2%B7%20TypeScript-blue)
![PWA](https://img.shields.io/badge/PWA-ready-brightgreen)
![Storage](https://img.shields.io/badge/storage-localStorage%20only-lightgrey)

---

## What this app is, and which app it isn't

There are three builds of this codebase. They share `src/lib`, `src/pages`, `src/components`,
`src/types` and `src/context` almost byte-for-byte, and differ only in where the rows go.

| App | Role | Backend |
|---|---|---|
| `finance-ledger-test` | **Test app.** Where non-Supabase development happens first. Deployed freely. | None |
| **`personal-ledger`** *(this repo)* | **Live offline app.** Single device, `localStorage` only. | None — permanently offline |
| `shared-finance-ledger` | **Live syncing app** for a two-person household. | Supabase + PowerSync |

> 🚨 **Do not add Supabase, PowerSync, auth, cloud backup or any syncing to this repo.** Syncing
> lives in `shared-finance-ledger`. Backup here is the manual JSON download/upload on the Wallet
> page, and nothing else. This app has a real user with real, unbacked-up financial data: any
> change touching persistence, `migrateLedgerData`, or the shape of `AppDataV2` must be
> backward-compatible with data already sitting in her browser.

Divergence between this app and `shared-finance-ledger` is kept **structural, not textual**:
persistence sits behind one `LedgerStore` interface with two implementations, so
`src/context/LedgerContext.tsx` and everything above it stay identical in both repos. The register
that enforces it is `DIVERGENCE.md` in the shared repo, checked by `npm run check:divergence`
there.

---

## Getting started

```bash
npm install
npm run dev          # vite dev server, usually http://localhost:5173
npm run build        # tsc -b && vite build
npm run lint         # oxlint
npm test             # vitest (SavingsPotForm + LedgerProvider suites)
npm run verify       # scripts/verify.ts
npm run deploy       # builds and publishes dist/ to the gh-pages branch — publishes the LIVE site
```

Add yourself on the **Wallet** tab first: the app shows empty states until there is at least one
person with a salary and a pay cycle. To install it on an iPhone, open it in Safari and tap
Share → **Add to Home Screen**. `vite.config.ts` uses a relative base (`base: './'`), so it works
from any repo name or sub-path.

> `npm run deploy` is what actually publishes the live site. It is never run without being asked
> for in so many words.

---

## Visual design

**Typeface and colour.** Space Grotesk for display text, Inter for body, JetBrains Mono for
figures, all loaded from Google Fonts. The palette is a dark, near-navy ground
(`--color-bg: #0e1320`) with layered surface tokens, defined once in `src/index.css` alongside
`--color-ink` / `--color-ink-muted` / `--color-ink-faint`, `--color-track`, `--color-positive`,
`--color-negative`, `--color-warning`, and per-person and per-card colours. **Coral**
(`--color-coral: #ff5b4c`) is the single accent — the active nav tab, the "· Adjusted" badge, and
pre-picked choices inside a wizard.

**The app shell.** `#app-shell` is sized from a JS-measured `--app-height` rather than `100dvh`,
because iOS standalone reports a stale viewport on first paint. `#app-content` is the app's *only*
scroll container, which is why route changes reset its scroll manually (`ScrollToTop` in
`App.tsx`) and why every modal must portal to `document.body` — an overlay rendered inside an
`overflow-y-auto` parent is clipped, and neither a z-index bump nor switching to `absolute` fixes
it.

**Edge fades.** Gradient strips pinned to the top and bottom of the shell fade scrolling content
into the background rather than hard-clipping it at the safe-area boundary.

**The nav bar.** A floating pill inset from each edge, `position: absolute` against `#app-shell`
(not `fixed`, which breaks on iOS standalone), with six tabs — icon stacked above a permanently
visible label. The active tab is filled coral.

| Tab | Route | Page component | What it is |
|---|---|---|---|
| Home | `/` | `pages/Home.tsx` | The wallet deck and the ledger |
| Wallet | `/salary` | `pages/Salary.tsx` | Salary, pensions, savings, pots, joint account, backup |
| Borrowing | `/loans` | `pages/Loans.tsx` | Loans and credit cards |
| Bills | `/bills` | `pages/Bills.tsx` | Recurring bills |
| Transactions | `/expenses` | `pages/Expenses.tsx` | Ad-hoc entries, recurring, transfers, overpayments |
| What-if | `/scenarios` | `pages/Scenarios.tsx` | Scenario modelling |

**Swipe-to-delete** is the delete gesture on every list row (`components/SwipeToDelete.tsx`).
Regions that scroll horizontally inside a row are marked `[data-no-swipe]` so a drag inside them
never starts the parent row's swipe.

---

## The idea underneath everything

A **`Transaction`** is the only thing that carries money. Bills, loans, credit-card minimums,
pensions, salary, pot deposits and savings interest are *generators* of transactions, not
balances in their own right. Every balance in the app is a fold over the transaction list.

Generators are pure: they compute *what should exist* in a date range and the caller dedupes
against what already does. Nothing is materialised until its date arrives, at which point
`autoClearDuePayments` writes it as a real, persisted, `cleared` row.

Two rules fall out of that, and most of the app's behaviour follows from them:

- **There is no tap-to-clear anywhere.** A payment settles by itself the moment today reaches its
  date.
- **Cleared is immutable.** A cleared transaction is historical fact and is never retroactively
  rewritten or deleted. Put your rate up today and yesterday's numbers do not move. The one
  deliberate exception is a row dated *today* whose generator is deleted — that one is swept.

---

## Screens

### Home — the wallet deck and the ledger

The top half is a **stacked wallet of cards** you tap to bring to the front; the bottom half is
that card's own ledger. The deck order is fixed — Personal, Joint, Pots, Credit Cards, Loans,
Savings Pots, Household — and each entry has its own visibility rule (Joint and Household need a
second person; a loan card disappears once the loan is settled or fully repaid). Tapping a card
promotes it; everything else keeps its relative order.

**Every hero card reads the same three figures, and they reconcile by eye:** *Current balance*
(everything cleared), *Pending* (the net of everything still to happen inside the horizon —
outgoings negative, salary and incoming positive), and *Projected*. Current + Pending is exactly
Projected, for every horizon, by construction.

- **Personal** — your current account. Below the card, a pop-down **income/outgoings breakdown**
  splits the cycle into income (salary, withdrawals, other income) against outgoings (standing
  orders, deposits, other), ending on what is actually left.
- **Joint** — the joint account as a real account with its own reconciled opening balance, fed by
  joint bills and loans and by hand-logged joint transfers. Its own breakdown card mirrors
  Personal's.
- **Household** — every person's *own* personal picture side by side. Deliberately **not** joint
  bills, and not a synthetic per-person share of one. A per-person pill shows that person's **net
  for the cycle**, not a balance.
- **Credit card** — one card per active card you own, showing what is owed and what is projected.
  🚨 **Credit cards use their own payment periods**, from the card's own payment day and statement
  window, with the due date as the last day of the cycle. Every other card type follows the
  household pay cycle. This is a hard rule.
- **Loan** — one card per loan, with the amount owed and the projection.
- **Pot / Savings pot** — one card each, with today's balance, and for a savings pot a target ring
  and a "how much per pay period to hit the target" figure.

**The controls under the deck** are a horizon pill (*This cycle* / *Next 3 cycles*) plus a single
**Filters** sheet holding: group by List / Category / Person, order by Date / Amount, *Show
cleared*, *Cycle-end totals*, *Group by direction*, and *Average spend forecast*. Whatever is
switched on is summarised as chips next to the button, and a **Reset to default** restores the
lot. A control that does not apply to the current card says so rather than disappearing ("A loan
only has repayments going one way").

- **Cycle-end totals** groups the window into pay-cycle sections, each with its own closing
  balance.
- **Group by direction** splits any view into Incoming and Outgoing pills — nested inside each
  cycle when cycle totals are on.
- **Average spend forecast** (Personal and Joint only) projects a placeholder average for ad-hoc
  card/cash spending, derived from a daily rate over your trailing history and reduced by whatever
  real ad-hoc spend already sits in that cycle. It never includes bills, loans, card spend or
  income.

**Progress section.** Below the ledger, loans and credit cards get progress bars and rings. A
loan's ring is three arcs — green paid, amber projected over the horizon, red remaining — with a
legend table above it. 🚨 **The ring and the legend deliberately carry different numbers:** the
amber *arc* is the increment (it is drawn where green stops), the amber *row* is the cumulative
figure, so the legend's `%` column sums to more than 100. That is correct. Tapping through opens a
modal with its own horizon control, independent of the page's.

**Trends.** A "View trends" control opens a chart modal: Balance or Spend over This Cycle / Next 3
Cycles for an account, and a pill chart over This Cycle / Last 6 Cycles / Year for a savings pot.
A savings pot pill's **fill is the period's end balance**, with the full track being the highest
balance reached anywhere in the view, and its tooltip shows the net change plus gross in/out.

### Wallet — salary, pensions, savings, pots, the joint account

Five collapsible sections plus backup.

- **Salary.** One row per person. Set up gross annual salary, tax code, student loan plan,
  employer pension %, and any number of named deductions (fixed or percentage, pre- or post-tax).
  Salary is a **dated history**, not one figure — a new job is a new snapshot effective from a
  date, so past periods keep the numbers that were true then. **Pay periods** lists the next four
  paydays and a collapsed history, each tapping into the same editor: a full gross-to-net
  breakdown, an override for a one-off different net pay, and **+ Add bonus** (taxed properly and
  logged as its own incoming row, never folded invisibly into payday).
  - **Sort this salary** opens the **Salary Sorter**: split a payday across your pots and the
    joint account in one pass, with suggested amounts derived from what that cycle actually needs.
    Each target becomes a real, independently editable transfer; editing or deleting the transfer
    keeps the sort in step.
  - The **cog** opens pay cycle settings: payday day-of-month, whether payday moves to the last
    working day before a weekend or bank holiday, the budgeting cycle start, opening balance, the
    round-up switch (while no Coin Jar exists), and whether Salary Sort suggestions follow payday
    or the budgeting cycle.
  - **Pay frequency and pay schedule are different things.** Frequency is a *tax* question
    (monthly, four-weekly, four-weekly fiscal); schedule is a *date* question. A four-weekly
    salary with no schedule is never guessed — the Wallet asks for the next pay date instead.
- **Pensions.** A pension is its own scheduled income source with its own name, amount history,
  frequency, anchor date and weekend adjustment, and its rows are labelled with the pension's name
  rather than "Salary".
- **Savings.** Savings pots with an opening balance and date, a colour and icon, an optional
  target amount and date, recurring deposits, and a real **interest engine** — either an AER
  credited monthly/quarterly/annually, or a daily-accrual convention that replays every deposit
  and withdrawal. Interest can be paid into the same pot or somewhere else. An info-icon opens the
  pot's own ledger, where a credited interest payment is the one thing that can be hand-overridden.
- **Pots.** A pot is a separate entity from a savings pot: it is the thing bills, loans and card
  minimums are *paid from*. Its expanded form carries **What this pot pays** — a checklist of the
  bills and loans routed through it. A **Coin Jar** is a special pot created by the round-up
  switch rather than by a form, which is why it is the only pot whose opening balance stays
  editable, and the only one that offers no ring, target, recurring deposits or bill funding.
- **Joint Account.** Its own reconciled opening balance and date, plus **Rebalance all accounts**.
- **Manage people** — add, rename, recolour, set the primary person ("this is your dashboard
  view"). Deleting a person is **blocked** while anything still references them; the delete sheet
  stages a Move or Delete decision per blocking item and applies them all at once, or none.
- **Backup** — download the whole ledger as JSON, and restore from one. See **What each button
  does** below.

### Borrowing — loans and credit cards

**Loans.** Name, monthly payment (with its own effective-dated history), term, first payment date,
category, colour, and where the payment is paid from. Under the hood this is a genuine
reducing-balance amortisation engine, not a flat countdown: it back-solves the effective monthly
rate from payment + principal + term, because a displayed APR is routinely rounded and the
lender's real internal rate sits a hair either side of it.

- **Calibrate interest** — enter two to five real statement lines (date, capital, interest) and
  the engine fits them against a small library of real-world interest conventions, keeping
  whichever fits best. Lines are kept, so re-fitting always uses the whole accumulated set.
- **Overpayments** — one-off and recurring, each choosing whether to **keep the same length**
  (lower the payment) or **keep the payment the same** (finish sooner). A recurring overpayment
  can be paused per occurrence and paid from a pot.
- **Settle this loan** logs a real payoff at the amount actually paid, which may differ from the
  app's own settlement estimate.
- The loan's **ledger modal** lists every monthly repayment, ad-hoc overpayment and recurring
  overpayment with its capital/interest split.

**Credit cards.** Name, APR, current balance as at a stated date, minimum payment (a fixed amount
or a percent of balance), payment day, an optional statement window, and where the minimum is paid
from. The balance is **derived, not stored**: `currentBalance` is an anchor as at
`balanceAsOfDate`, and what the card owes right now is replayed forward from it with real monthly
interest. Log ad-hoc lump payments, set a one-off different minimum charge, or **Set to Clear** a
statement.

A statement window changes which cycle spend belongs to: spend inside a window is due on the
payment date *after* that window closes. Without a window, spend counts toward the very next
payment date with no lag.

### Bills — recurring bills

One row per bill: name, amount, category, payment method, frequency (weekly, every N weeks,
monthly, quarterly, annual — or a single payment), first due date, and location (Current Account,
Joint Account or a Pot), with a joint bill carrying a payee and a split percentage.

Amounts are **effective-dated**: changing one asks which payment it starts from and leaves
everything before it alone. **Manage upcoming payments** lists the last payment on or before today
plus the next twelve, and lets you move a date, change an amount, or pause an occurrence
individually — each of which is stored against that occurrence's *slot*, never its date. Anything
differing from what the schedule would naturally produce is badged "· Adjusted".

🚨 **Changing when a schedule pays re-dates stored payments; it never re-creates them.** You pick
the payment the change starts from; from there on, stored payments are re-dated one-to-one and the
keyed data (overrides, pauses, amount boundaries) moves with them. Nothing before it is touched.

### Transactions — four tabs

- **Transactions** — ad-hoc expenses, income, bonuses and credit-card spend, logged through a
  short wizard (name → amount → date → category → payment method → location, with a card step when
  it is a card, and a round-up step when a Coin Jar exists). The category step starts on the
  category of the most recent past transaction with a similar name, so "tesco" finds your last
  Tesco shop. Cleared entries are grouped by month and collapsed.
- **Recurring** — recurring expenses and income on the same schedule engine as Bills, personal
  only, with the same per-occurrence edit/pause and effective-dated amount change.
- **Transfers** — one-off or recurring, between any two of: current account, a savings pot, the
  joint account, a pot. A recurring transfer can **follow payday** or **follow the cycle start**
  rather than a fixed calendar date.
- **Overpayments** — create and manage one-off and recurring loan overpayments.

### What-if — scenarios

Build a named scenario out of actions — sell an asset, a new bill, a new finance agreement, a
salary change, buy something, a lump sum into or a withdrawal from a savings pot, change a pot's
recurring deposit — and see the impact: change in available cash per month, one-off cash impact,
and for a debt, the new payoff date and months saved. A **purchase** action is the one that is
genuinely date-aware: it runs against the real projection, so it can answer "what will my balance
be that day, and what am I left with by the end of that cycle?"

Scenarios can be included in a combined view, and a scenario's loan overpayment can be **converted
to a real recurring overpayment** in one tap.

---

## How the money maths works

**UK tax** (`src/lib/tax.ts`) — 2026/27 rates. It calculates **per period**, the way real PAYE
does, using HMRC's published per-period thresholds and payroll rounding, rather than working out an
annual figure and dividing. It is a non-cumulative ("Month 1") calculation: for level pay it
matches a real payslip to the penny, and the annual figure can differ from a true year-end
reconciliation by a pound or two. Covers Personal Allowance and its taper, the 20/40/45 bands,
employee NI, student loan plans 1/2/4/5 and postgraduate, and pension relief at source, salary
sacrifice or net pay — each of which changes what tax and NI are actually calculated against.

**Loans** (`src/lib/ledgerLoans.ts`, `src/lib/interestConventions.ts`) — reducing-balance
amortisation with a fitted interest convention. There is no single "the" loan formula, so the
engine tests a growable library of candidates against your real statement lines and keeps the best
fit.

Two totals exist and they are not interchangeable: **`nominalTotalPayable`** is the contractual
total, deliberately frozen against overpayments, and is what settlement figures use.
**`amortisedTotalPayable`** is the real schedule's own total after every logged overpayment, and is
what a progress figure needs — against the contractual total, an overpaid loan can never reach
100%.

**Credit cards** (`src/lib/creditCards.ts`) — APR compounded monthly against the balance each
billing cycle, with two balances tracked: the true running balance, and the statement balance the
minimum is sized off (deliberately lagged on a windowed card). They can legitimately diverge.

**Pay cycles** (`src/lib/payCycle.ts`) — payday and the budgeting cycle boundary are two
independent dates, on purpose. Bank holidays are computed rather than tabulated, including the real
UK substitute-day rule and Easter, so payday resolution keeps working for any future year without a
data update. England & Wales only.

**The fiscal calendar** (`src/lib/fiscalCalendar.ts`) — for a four-weekly earner, a 4-4-4 fiscal
year ending on the last pay weekday on or before 31 March, with a five-week period 13 when the year
runs 371 days. Those long years arrive every five *or* six years, so the calendar is computed, never
assumed.

**Round-ups and the Coin Jar** (`src/lib/roundUp.ts`) — a £7.50 card shop is stored as £8.00,
remembering it came from £7.50. The 50p funds a pot called Coin Jar. Card expenses only: not cash,
not a bank transfer, not a bill or any card-related row, and nothing located in a pot or the joint
account. 🚨 **There is no second transaction** — the jar's balance is derived from the difference
on the rows that name it, so deleting the expense takes its 50p with it automatically. You can opt
a single transaction out, and that opt-out is stored rather than inferred. Switching round-ups on
or off asks for a date it applies from — **a plain calendar date, not a payday** (2026-09-22): the
switch re-dates nothing already logged, so it does not have to land on one, and a person with no
salary configured can still use it.

---

## Data and backup

Everything lives under one `localStorage` key, `ledger:app-data-v2:v1`, as one JSON blob
(`AppDataV2`). `migrateLedgerData` runs on every load and backfills anything a newer version
expects; it never rewrites history.

**Wallet → Backup** downloads the whole thing as a dated JSON file and restores from one. **A
restore is a full replace, with a confirmation and no undo.** That is the only backup this app has
— there is no cloud copy — so take one before anything risky.

---

## Testing

The house testing idiom is `scripts/verify-*.ts`: plain `tsx` executables printing ✓/✗, run
directly, with a header explaining the real bug each one prevents. Several read the real backup
files in `scripts/fixtures/`. **Write one alongside any change to `src/lib/`.**

```bash
npx tsc -b                # must be clean
npx vitest run            # component/provider suites
for f in scripts/verify-*.ts; do out=$(npx tsx "$f" 2>&1); rc=$?; \
  if [ $rc -ne 0 ] || echo "$out" | grep -qE "✗|^FAIL|Error:"; then \
  echo "FAIL: $f"; echo "$out" | grep -E "✗|^FAIL|Error:" | head -5; fi; done; echo DONE
```

A non-zero exit, a `✗`, a line starting `FAIL`, or an `Error:` all count as a failure — an
`✗`-only grep once let eight crashing scripts count as passes.

---

## Known limitations

- **Single device.** No sync, no cloud backup, no account. If the browser's storage is cleared and
  there is no JSON backup, the data is gone.
- **Two-person households only** for joint splitting. `payee` plus `payeeSharePercent` is a two-way
  split by construction; three or more people are not modelled.
- **England & Wales bank holidays only.** Scotland and Northern Ireland diverge.
- **Scottish tax bands are not modelled** in the per-period engine; an S code is treated as
  rest-of-UK.
- **Tax constants are 2026/27 only.** They are plain constants at the top of `tax.ts` and should be
  re-checked at the start of each tax year.
- **A restore is a full replace**, not a merge.
- **Auto-clear is not byte-deterministic**: loading the same data twice can store different JSON,
  because newly due rows get fresh ids. Normalise new-row ids when comparing builds.

---

## Where the rest is written down

| Document | Holds |
|---|---|
| `TECHNICAL.md` | This repo's implementation reference — architecture, data model, every module and every engine |
| `src/types/ledger.ts` | **The comments are the spec.** Read them before changing what a field means |
| `shared-finance-ledger/DIVERGENCE.md` | The enforced register of what may differ between the two live apps |
| `Downloads/App Development & Bug Tracking/personal-ledger/` | Dated development notes, prompts and UAT scripts |


## What each button does

Plain English, for when you are looking at the app rather than the code. There are two, both on the
Wallet page in the **Backup** card, and neither has an equivalent anywhere else in this app.

### ↓ Download

Writes your **whole ledger** to a `.json` file. On an iPhone that opens the Share Sheet; elsewhere
it is an ordinary download.

- Nothing leaves the device unless you then send the file somewhere yourself.
- It changes no data. It is always safe.

### ↑ Restore from a file

You pick a `.json` file, and then **the app's own confirmation appears** — it names the file, says
what is in the app right now, and says what is in the file. Confirm and **everything currently in
the app is replaced by the file's contents**.

> 🚨 **This is a full replace, not a merge, and it cannot be undone.** There is no cloud copy behind
> it in this app — whatever you replace is gone, and the file you picked is the only version that
> survives. That is why the confirmation spells out both sides before you commit to it.

(Until PROMPT-14 this was the browser's own grey confirm box, which had no room to say any of that.)

### There is no Force Sync here

There is nothing to sync to. This app is localStorage-only, permanently — no account, no server, no
cloud backup. `shared-finance-ledger` is the app that syncs, and it has a **Force Sync** button in
its Account modal; this one deliberately does not.
