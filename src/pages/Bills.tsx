import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatFullDate } from '../lib/format'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, Trash2, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { BILLS_CATEGORY_ID } from '../types/ledger'
import type { PaymentMethod, RecurrenceFrequency, RecurringTemplate, Pot } from '../types/ledger'
import type { BillLocation } from '../types/models'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { visibleCategoriesFor } from '../lib/categories'
import { CategoryManagerButton } from '../components/CategoryManagerModal'
import { LocationEditor } from '../components/LocationEditor'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { ConfirmModal } from '../components/ConfirmModal'
import { FormButtonRow, CancelButton, SaveButton } from '../components/FormButtons'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { peopleWithIncomeCount } from '../lib/household'
import { shouldOfferLocationPicker } from '../lib/pickerFirst'
import { recentAndUpcomingOccurrences, applyTemplateAmountChange, scheduledTemplateDates, setPausedTemplateOccurrences, resolveTemplateAmount, templateOccurrencePreviews } from '../lib/schedule'
import { addMonths } from 'date-fns'
import { PausedOccurrencesControl } from '../components/PausedOccurrencesControl'

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  direct_debit: 'Direct Debit',
  standing_order: 'Standing Order',
}

const FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  weekly: 'Weekly',
  every_n_weeks: 'Every N weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
}

import { todayIso } from '../lib/date'

type BillPrefill = Partial<Omit<RecurringTemplate, 'id' | 'active'>>

/** Same "who's this for?" picker as Loans.tsx's/Salary.tsx's — own local copy per this codebase's per-page-file convention for small shared UI. */
function PersonPickerCard({ people, onPick, onCancel }: { people: { id: string; name: string }[]; onPick: (personId: string) => void; onCancel: () => void }) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Who's this for?</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {people.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p.id)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * "Where does this get paid from?" — Picker-First Flows (2026-09
 * session). A single flat list: Current Account, Joint (if `canBeJoint`),
 * then each of the chosen owner's own pots by name — picking a pot
 * directly sets both `location: 'pot'` and its `potId` in one tap, no
 * further sub-step (Adam-specified: "single list of locations"). Not
 * shown at all by the caller when Current Account is the only possible
 * answer (see Bills()/Loans()'s own skip check) — this component doesn't
 * re-check that itself, matching PersonPickerCard's own "caller decides
 * whether to render me" convention.
 */
function LocationPickerCard({
  canBeJoint,
  ownerPots,
  onPick,
  onCancel,
}: {
  canBeJoint: boolean
  ownerPots: Pot[]
  onPick: (pick: { location: BillLocation; potId?: string }) => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Where does this get paid from?</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <button onClick={() => onPick({ location: 'personal' })} className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]" style={{ background: 'var(--color-surface)' }}>
          Current Account
        </button>
        {canBeJoint && (
          <button onClick={() => onPick({ location: 'joint' })} className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]" style={{ background: 'var(--color-surface)' }}>
            Joint Account
          </button>
        )}
        {ownerPots.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick({ location: 'pot', potId: p.id })}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Bills() {
  const { data, addRecurringTemplate, updateRecurringTemplate, removeRecurringTemplate, addCategory, assignRecurringTemplateLocation } = useLedgerData()
  const [adding, setAdding] = useState(false)
  // Picker-First Flows (2026-09 session) — Owner then Location, each
  // independently skipped when there's nothing to actually choose
  // (Adam-specified): Owner skips with only one person; Location skips
  // when Current Account is the only possible answer (no joint AND the
  // chosen owner has no pots). Both are just smart DEFAULTS fed into
  // BillForm's existing, still-fully-editable fields (Adam's explicit
  // 2026-09 call: "all picker-first values are editable fields
  // afterwards") — not a locked-in choice.
  const [pickingBillOwner, setPickingBillOwner] = useState(false)
  const [pickingBillLocation, setPickingBillLocation] = useState(false)
  const [billDefaultOwnerId, setBillDefaultOwnerId] = useState(data.primaryPersonId)
  const [billDefaultLocation, setBillDefaultLocation] = useState<{ location: BillLocation; potId?: string }>({ location: 'personal' })
  const [locationFilter, setLocationFilter] = useState<'all' | BillLocation>('all')
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const prefill = (routerLocation.state as { billPrefill?: BillPrefill } | null)?.billPrefill
  // "Joint" is only offered as a location choice once 2+ people actually
  // have real income (salary or an active pension) configured — see
  // lib/household.ts's hasIncomeConfigured for why this differs from a
  // plain people.length check.
  const canBeJoint = peopleWithIncomeCount(data.people, data.pensions) >= 2

  // Shared by both the single-person-owner shortcut and PersonPickerCard's
  // onPick — decides whether the Location step is worth showing at all
  // for the now-known owner, then either shows it or jumps straight to
  // BillForm with location left at its Current-Account default.
  function proceedPastOwner(ownerId: string) {
    setBillDefaultOwnerId(ownerId)
    const ownerHasPots = data.pots.some((p) => p.personId === ownerId && p.active)
    if (shouldOfferLocationPicker(canBeJoint, ownerHasPots)) {
      setPickingBillLocation(true)
    } else {
      setBillDefaultLocation({ location: 'personal' })
      setAdding(true)
    }
  }

  useEffect(() => {
    if (prefill) setAdding(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.state])

  const visibleBills = data.recurringTemplates
    .slice()
    .filter((t) => locationFilter === 'all' || t.location === locationFilter)
    .sort((a, b) => new Date(a.anchorDate).getDate() - new Date(b.anchorDate).getDate())

  // Pots backlog item (2026-09 session) — the filter chip row only offers
  // a location that's actually in use anywhere, same "invisible until it
  // would do something" instinct as the whole row's own visibility guard
  // below (which now also fires once a bill is pot-located, not just
  // joint).
  const filterOptions: ('all' | BillLocation)[] = ['all', 'personal', ...(data.recurringTemplates.some((t) => t.location === 'joint') ? (['joint'] as const) : []), ...(data.recurringTemplates.some((t) => t.location === 'pot') ? (['pot'] as const) : [])]

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Bills</h1>
        <div className="flex items-center gap-2">
          <CategoryManagerButton />
          <button
            onClick={() => {
              if (data.people.length === 1) {
                proceedPastOwner(data.people[0].id)
              } else {
                setPickingBillOwner(true)
              }
            }}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-coral)' }}
          >
            <Plus size={18} className="text-white" />
          </button>
        </div>
      </header>

      {pickingBillOwner && (
        <PersonPickerCard
          people={data.people}
          onPick={(id) => {
            setPickingBillOwner(false)
            proceedPastOwner(id)
          }}
          onCancel={() => setPickingBillOwner(false)}
        />
      )}

      {pickingBillLocation && (
        <LocationPickerCard
          canBeJoint={canBeJoint}
          ownerPots={data.pots.filter((p) => p.personId === billDefaultOwnerId && p.active)}
          onPick={(pick) => {
            setBillDefaultLocation(pick)
            setPickingBillLocation(false)
            setAdding(true)
          }}
          onCancel={() => setPickingBillLocation(false)}
        />
      )}

      {adding && (
        <BillForm
          people={data.people}
          pots={data.pots}
          canBeJoint={canBeJoint}
          categories={visibleCategoriesFor(data)}
          defaultOwnerId={billDefaultOwnerId}
          defaultLocation={billDefaultLocation.location}
          defaultPotId={billDefaultLocation.potId}
          initial={prefill}
          onAddCategory={addCategory}
          onCancel={() => {
            setAdding(false)
            if (prefill) navigate('.', { replace: true, state: null })
          }}
          onSave={(template) => {
            addRecurringTemplate(template)
            setAdding(false)
            if (prefill) navigate('.', { replace: true, state: null })
          }}
        />
      )}

      {filterOptions.length > 2 && (
        <div className="flex gap-2 mb-4">
          {filterOptions.map((option) => {
            const active = locationFilter === option
            return (
              <button
                key={option}
                onClick={() => setLocationFilter(option)}
                className="px-3 py-1.5 rounded-full text-xs font-medium capitalize transition-colors"
                style={{
                  background: active ? 'var(--color-coral)' : 'var(--color-surface)',
                  color: active ? '#fff' : 'var(--color-ink-muted)',
                }}
              >
                {option}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {visibleBills.map((template) => (
          <BillRow
            key={template.id}
            template={template}
            people={data.people}
            pots={data.pots}
            canBeJoint={canBeJoint}
            categories={visibleCategoriesFor(data, template.categoryId)}
            onAddCategory={addCategory}
            onUpdate={(u) => updateRecurringTemplate(template.id, u)}
            onAssignLocation={(location, effectiveFrom, potId) => assignRecurringTemplateLocation(template.id, location, effectiveFrom, { potId })}
            onRemove={() => removeRecurringTemplate(template.id)}
          />
        ))}
        {visibleBills.length === 0 && !adding && (
          <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">No bills yet. Add one to get started.</p>
        )}
      </div>
    </div>
  )
}

function FrequencyEditor({
  frequency,
  intervalWeeks,
  anchorDate,
  onChange,
}: {
  frequency: RecurrenceFrequency
  intervalWeeks: number | undefined
  anchorDate: string
  onChange: (patch: { frequency?: RecurrenceFrequency; intervalWeeks?: number; anchorDate?: string }) => void
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Frequency</span>
        <select
          value={frequency}
          onChange={(e) => onChange({ frequency: e.target.value as RecurrenceFrequency })}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        >
          {(Object.keys(FREQUENCY_LABELS) as RecurrenceFrequency[]).map((f) => (
            <option key={f} value={f} style={{ color: '#000' }}>
              {FREQUENCY_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      {frequency === 'every_n_weeks' ? (
        <EditField label="Every N weeks" type="number" value={intervalWeeks ?? 2} onChange={(v) => onChange({ intervalWeeks: Math.max(1, Number(v)) })} />
      ) : (
        <EditField
          label={frequency === 'weekly' ? 'First due date' : 'Due date (sets the day/month)'}
          type="date"
          value={anchorDate}
          onChange={(v) => onChange({ anchorDate: v })}
        />
      )}
      {frequency === 'every_n_weeks' && <EditField label="First due date" type="date" value={anchorDate} onChange={(v) => onChange({ anchorDate: v })} />}
    </>
  )
}

function PaymentMethodEditor({ value, onChange }: { value: PaymentMethod; onChange: (v: PaymentMethod) => void }) {
  return (
    <label className="flex flex-col gap-1 col-span-2">
      <span className="text-xs text-[var(--color-ink-muted)]">Payment method</span>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((pm) => (
          <button
            key={pm}
            onClick={() => onChange(pm)}
            className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
            style={{ background: value === pm ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: value === pm ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {PAYMENT_METHOD_LABELS[pm]}
          </button>
        ))}
      </div>
    </label>
  )
}

function BillRow({
  template,
  people,
  pots,
  canBeJoint,
  categories,
  onAddCategory,
  onUpdate,
  onAssignLocation,
  onRemove,
}: {
  template: RecurringTemplate
  people: { id: string; name: string }[]
  pots: Pot[]
  canBeJoint: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onUpdate: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onAssignLocation: (location: BillLocation, effectiveFrom: string, potId?: string) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const category = categories.find((c) => c.id === template.categoryId)
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()
  // Pots backlog item (2026-09 session) — "all bills paid out of a pot
  // gain a pill/badge with the pot name in the Bills page" (Adam's spec,
  // verbatim).
  const pot = template.location === 'pot' ? pots.find((p) => p.id === template.potId) : undefined

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={template.name}>
      {/* A paused bill is dimmed with a SOLID darker background and
          struck-through text, never with `opacity` — a translucent row let
          the red delete button sitting behind it (SwipeToDelete) bleed
          through as a permanent pink wash on every paused row, which read
          as a rendering fault rather than as "paused". */}
      <div className="relative rounded-xl px-4 py-3" style={{ background: template.active ? 'var(--color-surface)' : 'var(--color-bg-elevated)' }}>
        <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <CategoryIcon category={category} />
            <div className="min-w-0">
              <p className="font-body text-sm" style={{ color: template.active ? 'var(--color-ink)' : 'var(--color-ink-muted)', textDecoration: template.active ? 'none' : 'line-through' }}>
                {template.name}
                {!template.active && <span className="text-[10px] font-normal no-underline"> · Paused</span>}
              </p>
              <p className="text-xs text-[var(--color-ink-faint)] flex items-center gap-1.5">
                <span>
                  {template.location === 'joint' ? 'Joint' : template.location === 'pot' ? 'Personal' : 'Personal'} · {FREQUENCY_LABELS[template.frequency]} · {PAYMENT_METHOD_LABELS[template.paymentMethod]}
                </span>
                {/* Batch 3 (2026-09-04 UAT): pot bills already got a
                    name pill — joint bills only ever had the plain
                    "Joint" text above, no badge. Added alongside the pot
                    pill. Deliberately NOT --color-joint (that token is
                    #fdfdfd, a near-white BankCard background fill, not a
                    badge accent — white-on-white would repeat the exact
                    invisible-Cancel-button bug from Batch 2) and NOT
                    --color-positive (already means "financially good"
                    everywhere else in the app, e.g. deposits/income) —
                    a neutral outlined pill instead, same border-based
                    approach Batch 2's Cancel-button fix used, which
                    reads against any background. */}
                {template.location === 'joint' && (
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0"
                    style={{ background: 'var(--color-surface-raised)', border: '1px solid var(--color-track)', color: 'var(--color-ink-muted)' }}
                  >
                    Joint
                  </span>
                )}
                {pot && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0" style={{ background: 'var(--color-coral)', color: '#fff' }}>
                    {pot.name}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <span className="font-mono text-sm whitespace-nowrap" style={{ color: template.active ? 'var(--color-ink)' : 'var(--color-ink-muted)', textDecoration: template.active ? 'none' : 'line-through' }}>
              £{formatCurrency(template.amount)}
            </span>
            {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
          </div>
        </button>

        {open && (
          <BillEditPanel
            template={template}
            people={people}
            pots={pots}
            canBeJoint={canBeJoint}
            categories={categories}
            onAddCategory={onAddCategory}
            onSave={(patch) => {
              onUpdate(patch)
              setOpen(false)
              triggerFlash()
            }}
            onAssignLocation={(location, effectiveFrom, potId) => {
              onAssignLocation(location, effectiveFrom, potId)
              setOpen(false)
              triggerFlash()
            }}
            onCancel={() => setOpen(false)}
            onDelete={onRemove}
          />
        )}

        <SavedFlashOverlay active={flashActive} />
      </div>
    </SwipeToDelete>
  )
}

// ── Draft-then-Save edit panel, matching the Salary page's PeriodEditor
// convention: nothing persists until the explicit bottom Save button is
// pressed. Re-mounts fresh (via the open && guard in BillRow) each time the
// row is expanded, so the draft always starts from the template's current
// saved values. ──

type BillDraft = Omit<RecurringTemplate, 'id'>

function draftFromTemplate(template: RecurringTemplate): BillDraft {
  const { id: _id, ...rest } = template
  return rest
}

function BillEditPanel({
  template,
  people,
  pots,
  canBeJoint,
  categories,
  onAddCategory,
  onSave,
  onAssignLocation,
  onCancel,
  onDelete,
}: {
  template: RecurringTemplate
  people: { id: string; name: string }[]
  pots: Pot[]
  canBeJoint: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onAssignLocation: (location: BillLocation, effectiveFrom: string, potId?: string) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<BillDraft>(() => draftFromTemplate(template))
  const [choosingEffectiveDate, setChoosingEffectiveDate] = useState<'amount' | 'location' | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Same 2-months-back/12-months-forward window Salary.tsx's pause
  // pickers use — see PausedOccurrencesControl's own comment.
  const pauseWindowStart = addMonths(new Date(), -2)
  const pauseWindowEnd = addMonths(new Date(), 12)
  const pauseWindowDates = scheduledTemplateDates(template, pauseWindowStart, pauseWindowEnd)
  const currentlyPausedDates = new Set((template.occurrenceOverrides ?? []).filter((o) => o.deleted && pauseWindowDates.includes(o.originalDate)).map((o) => o.originalDate))

  function update(patch: Partial<BillDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  const locationChanged = draft.location !== template.location || (draft.location === 'pot' && draft.potId !== template.potId)
  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): dims Save
  // when nothing's actually changed, matching the same rule the new
  // Transfer wizards already follow — same "compare against the mount-
  // time snapshot" approach `dirty` already uses elsewhere in this app
  // (e.g. PotEditForm's own checklist dirty check).
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromTemplate(template))

  function handleSaveClick() {
    // A genuine amount change gets routed through "which payment should
    // this apply from" — confirmed as a real gap, not just theoretical:
    // every generated (not-yet-cleared) occurrence, including one due
    // very soon, silently picked up a new amount immediately with no way
    // to say "not until the payment after next." Non-amount edits (name,
    // category, frequency, etc.) still save immediately, same as before —
    // this only applies when the number itself has actually changed.
    //
    // A location change (Pots backlog item, 2026-09 session) gets the
    // SAME "which payment does this apply from" question — but unlike an
    // amount change, the answer also RETROACTIVELY rewrites every
    // already-existing transaction on/after that date, cleared ones
    // included (Adam's own spec, and lib/locationChange.ts's own file
    // header). If BOTH changed in the same edit, one shared date covers
    // both — asking twice for one Save action would be needless friction
    // for something that in practice happens together (e.g. "this bill
    // moves to my Bills pot AND its amount just went up").
    if (draft.amount !== template.amount && recentAndUpcomingOccurrences(template, new Date()).length > 0) {
      setChoosingEffectiveDate('amount')
      return
    }
    if (locationChanged && recentAndUpcomingOccurrences(template, new Date()).length > 0) {
      setChoosingEffectiveDate('location')
      return
    }
    // No occurrences to anchor a date to yet (a brand-new-ish template) —
    // a location change can apply immediately via the normal save path,
    // same as it always could before this field existed.
    if (locationChanged) {
      onAssignLocation(draft.location, todayIso(), draft.location === 'pot' ? draft.potId : undefined)
      return
    }
    onSave(draft)
  }

  if (choosingEffectiveDate) {
    return (
      <BillEffectiveDateModal
        template={template}
        description={
          choosingEffectiveDate === 'amount'
            ? `${template.name} is changing from £${formatCurrency(template.amount)} to £${formatCurrency(draft.amount)}. Which payment should the new amount start from? Everything before it keeps the old amount.`
            : `${template.name} is moving ${draft.location === 'pot' ? `to ${pots.find((p) => p.id === draft.potId)?.name ?? 'a pot'}` : draft.location === 'joint' ? 'to Joint' : 'to Personal'}. Which payment should this start from? Everything before it — including already-cleared payments — stays where it was.`
        }
        onCancel={() => setChoosingEffectiveDate(null)}
        onChoose={(effectiveFrom) => {
          if (choosingEffectiveDate === 'amount') {
            const amountPatch = applyTemplateAmountChange(template, draft.amount, effectiveFrom)
            if (locationChanged) {
              // Both changed — apply the amount patch immediately, then
              // the location reassignment separately (it carries its own
              // retroactive transaction rewrite, which a plain onSave
              // patch can't do — see this component's own comment above).
              onSave({ ...draft, ...amountPatch })
              onAssignLocation(draft.location, effectiveFrom, draft.location === 'pot' ? draft.potId : undefined)
            } else {
              onSave({ ...draft, ...amountPatch })
            }
          } else {
            onAssignLocation(draft.location, effectiveFrom, draft.location === 'pot' ? draft.potId : undefined)
          }
        }}
      />
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <EditField label="Name" type="text" value={draft.name} onChange={(v) => update({ name: v })} />
      <EditField label="Amount (£)" type="number" value={draft.amount} onChange={(v) => update({ amount: Number(v) })} />
      <FrequencyEditor frequency={draft.frequency} intervalWeeks={draft.intervalWeeks} anchorDate={draft.anchorDate} onChange={update} />
      <div className="col-span-2">
        <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />
      </div>
      <LocationEditor
        people={people}
        pots={pots}
        canBeJoint={canBeJoint}
        location={draft.location}
        ownerId={draft.ownerId}
        potId={draft.potId}
        payee={draft.payee}
        payeeSharePercent={draft.payeeSharePercent}
        onChange={update}
      />
      <PaymentMethodEditor value={draft.paymentMethod} onChange={(paymentMethod) => update({ paymentMethod })} />
      <label className="flex items-center gap-2 col-span-2 mt-1">
        <input type="checkbox" checked={draft.active} onChange={(e) => update({ active: e.target.checked })} />
        <span className="text-xs text-[var(--color-ink-muted)]">Active (paused bills stop generating new payments)</span>
      </label>

      <div className="col-span-2">
        <PausedOccurrencesControl
          windowDates={pauseWindowDates}
          currentlyPaused={currentlyPausedDates}
          amountForDate={(date) => resolveTemplateAmount(template, date)}
          itemLabel="payments"
          nextPaymentPreview={(tentative) => {
            const previewTemplate: RecurringTemplate = { ...template, ...setPausedTemplateOccurrences(template, pauseWindowDates, tentative) }
            return templateOccurrencePreviews(previewTemplate, new Date(), 1)[0]?.date ?? null
          }}
          onSave={(pausedDates) => onSave(setPausedTemplateOccurrences(template, pauseWindowDates, pausedDates))}
        />
      </div>

      <button onClick={() => setConfirmingDelete(true)} className="col-span-2 flex items-center gap-1 text-xs justify-self-start mt-1" style={{ color: 'var(--color-negative)' }}>
        <Trash2 size={13} /> Delete bill
      </button>
      {confirmingDelete && (
        <ConfirmModal
          title={`Delete ${template.name}?`}
          description="Already-cleared payments stay in the ledger as historic fact — only future, not-yet-happened ones are removed."
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => {
            setConfirmingDelete(false)
            onDelete()
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      <div className="col-span-2 mt-1">
        <FormButtonRow onCancel={onCancel} onSave={handleSaveClick} saveDisabled={!dirty} />
      </div>
    </div>
  )
}

/**
 * "Which payment should this apply from?" — shown for either an amount OR
 * a location change (Pots backlog item added the latter, 2026-09
 * session — `description` is now caller-supplied so this one modal covers
 * both without hardcoding amount-specific wording). Same portal/nav-padding
 * pattern as Salary.tsx's ConfirmSalaryChangeModal, for the same reason
 * (see that component's own comment) — this modal sits inside a swipeable
 * row's tree too.
 */
function BillEffectiveDateModal({
  template,
  description,
  onCancel,
  onChoose,
}: {
  template: RecurringTemplate
  description: string
  onCancel: () => void
  onChoose: (effectiveFrom: string) => void
}) {
  const occurrences = recentAndUpcomingOccurrences(template, new Date())

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-1">Apply this change from…</h3>
        <p className="text-sm text-[var(--color-ink-muted)] mb-4">{description}</p>
        <div className="flex flex-col gap-2">
          {occurrences.map((o) => (
            <button
              key={o.date}
              onClick={() => onChoose(o.date)}
              className="w-full py-2.5 rounded-full text-sm font-semibold flex items-center justify-center gap-2"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}
            >
              {formatFullDate(o.date)}
              {o.isPast && <span className="text-xs font-normal text-[var(--color-ink-muted)]">(most recent)</span>}
            </button>
          ))}
        </div>
        <button onClick={onCancel} className="w-full py-2 mt-2 text-xs text-[var(--color-ink-muted)]">
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  )
}

function BillForm({
  people,
  pots,
  canBeJoint,
  categories,
  defaultOwnerId,
  defaultLocation,
  defaultPotId,
  initial,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  pots: Pot[]
  canBeJoint: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
  defaultLocation: BillLocation
  defaultPotId?: string
  initial?: BillPrefill
  onAddCategory: (name: string) => { id: string }
  onSave: (template: Omit<RecurringTemplate, 'id' | 'active'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [amount, setAmount] = useState(initial?.amount ? String(initial.amount) : '')
  const [frequency, setFrequency] = useState<RecurrenceFrequency>(initial?.frequency ?? 'monthly')
  const [intervalWeeks, setIntervalWeeks] = useState(initial?.intervalWeeks ?? 2)
  const [anchorDate, setAnchorDate] = useState(initial?.anchorDate ?? todayIso())
  const [location, setLocation] = useState<BillLocation>(initial?.location ?? defaultLocation)
  const [payee, setPayee] = useState(initial?.payee || people[0]?.id || '')
  const [payeeSharePercent, setPayeeSharePercent] = useState(initial?.payeeSharePercent ?? 50)
  const [ownerId, setOwnerId] = useState(initial?.ownerId || defaultOwnerId)
  const [potId, setPotId] = useState<string | undefined>(initial?.potId ?? defaultPotId)
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? BILLS_CATEGORY_ID)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initial?.paymentMethod ?? 'standing_order')

  const canSave = name.trim() && Number(amount) > 0 && anchorDate && categoryId

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <EditField label="Name" type="text" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Frequency</span>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {(Object.keys(FREQUENCY_LABELS) as RecurrenceFrequency[]).map((f) => (
              <option key={f} value={f} style={{ color: '#000' }}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        {frequency === 'every_n_weeks' && <EditField label="Every N weeks" type="number" value={intervalWeeks} onChange={(v) => setIntervalWeeks(Math.max(1, Number(v)))} />}
        <EditField label={frequency === 'weekly' || frequency === 'every_n_weeks' ? 'First due date' : 'Due date'} type="date" value={anchorDate} onChange={setAnchorDate} />
      </div>

      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />

      <LocationEditor
        people={people}
        pots={pots}
        canBeJoint={canBeJoint}
        location={location}
        ownerId={ownerId}
        potId={potId}
        payee={payee}
        payeeSharePercent={payeeSharePercent}
        onChange={(patch) => {
          setLocation(patch.location)
          if (patch.ownerId) setOwnerId(patch.ownerId)
          setPotId(patch.potId)
          if (patch.payee) setPayee(patch.payee)
          if (patch.payeeSharePercent !== undefined) setPayeeSharePercent(patch.payeeSharePercent)
        }}
      />

      <PaymentMethodEditor value={paymentMethod} onChange={setPaymentMethod} />

      <div className="flex gap-2 mt-1">
        <CancelButton onClick={onCancel} />
        <SaveButton
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              amount: Number(amount),
              categoryId,
              paymentMethod,
              frequency,
              intervalWeeks: frequency === 'every_n_weeks' ? intervalWeeks : undefined,
              anchorDate,
              location,
              payee: location === 'joint' ? payee : '',
              payeeSharePercent: location === 'joint' ? payeeSharePercent : 100,
              ownerId: location === 'personal' || location === 'pot' ? ownerId : '',
              potId: location === 'pot' ? potId : undefined,
            })
          }
          label="Add bill"
        />
      </div>
    </div>
  )
}
