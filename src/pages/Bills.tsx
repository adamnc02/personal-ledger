import { useEffect, useState } from 'react'
import { formatCurrency } from '../lib/format'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { BILLS_CATEGORY_ID } from '../types/ledger'
import type { PaymentMethod, RecurrenceFrequency, RecurringTemplate } from '../types/ledger'
import type { BillLocation } from '../types/models'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { visibleCategoriesFor } from '../lib/categories'
import { CategoryManagerButton } from '../components/CategoryManagerModal'
import { LocationEditor } from '../components/LocationEditor'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { peopleWithSalaryCount } from '../lib/household'

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

export function Bills() {
  const { data, addRecurringTemplate, updateRecurringTemplate, removeRecurringTemplate, addCategory } = useLedgerData()
  const [adding, setAdding] = useState(false)
  const [locationFilter, setLocationFilter] = useState<'all' | BillLocation>('all')
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const prefill = (routerLocation.state as { billPrefill?: BillPrefill } | null)?.billPrefill
  // "Joint" is only offered as a location choice once 2+ people actually
  // have a salary configured — see lib/household.ts's hasSalaryConfigured
  // for why this differs from a plain people.length check.
  const canBeJoint = peopleWithSalaryCount(data.people) >= 2

  useEffect(() => {
    if (prefill) setAdding(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.state])

  const visibleBills = data.recurringTemplates
    .slice()
    .filter((t) => locationFilter === 'all' || t.location === locationFilter)
    .sort((a, b) => new Date(a.anchorDate).getDate() - new Date(b.anchorDate).getDate())

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Bills</h1>
        <div className="flex items-center gap-2">
          <CategoryManagerButton />
          <button
            onClick={() => setAdding(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-coral)' }}
          >
            <Plus size={18} className="text-white" />
          </button>
        </div>
      </header>

      {adding && (
        <BillForm
          people={data.people}
          canBeJoint={canBeJoint}
          categories={visibleCategoriesFor(data)}
          defaultOwnerId={data.primaryPersonId}
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

      {data.recurringTemplates.some((t) => t.location === 'joint') && (
        <div className="flex gap-2 mb-4">
          {(['all', 'personal', 'joint'] as const).map((option) => {
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
            canBeJoint={canBeJoint}
            categories={visibleCategoriesFor(data, template.categoryId)}
            onAddCategory={addCategory}
            onUpdate={(u) => updateRecurringTemplate(template.id, u)}
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
  canBeJoint,
  categories,
  onAddCategory,
  onUpdate,
  onRemove,
}: {
  template: RecurringTemplate
  people: { id: string; name: string }[]
  canBeJoint: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onUpdate: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const category = categories.find((c) => c.id === template.categoryId)
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={template.name}>
      <div className="relative rounded-xl px-4 py-3" style={{ background: 'var(--color-surface)', opacity: template.active ? 1 : 0.55 }}>
        <div className="flex items-center justify-between cursor-pointer" onClick={() => setOpen(!open)}>
          <div className="flex items-center gap-2">
            <CategoryIcon category={category} />
            <div>
              <p className="font-body text-sm text-[var(--color-ink)]">
                {template.name}
                {!template.active && <span className="text-[var(--color-ink-faint)]"> · Paused</span>}
              </p>
              <p className="text-xs text-[var(--color-ink-faint)]">
                {template.location === 'joint' ? 'Joint' : 'Personal'} · {FREQUENCY_LABELS[template.frequency]} · {PAYMENT_METHOD_LABELS[template.paymentMethod]}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-[var(--color-ink)]">£{formatCurrency(template.amount)}</span>
            {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
          </div>
        </div>

        {open && (
          <BillEditPanel
            template={template}
            people={people}
            canBeJoint={canBeJoint}
            categories={categories}
            onAddCategory={onAddCategory}
            onSave={(patch) => {
              onUpdate(patch)
              setOpen(false)
              triggerFlash()
            }}
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
  canBeJoint,
  categories,
  onAddCategory,
  onSave,
  onDelete,
}: {
  template: RecurringTemplate
  people: { id: string; name: string }[]
  canBeJoint: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<BillDraft>(() => draftFromTemplate(template))

  function update(patch: Partial<BillDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
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
        canBeJoint={canBeJoint}
        location={draft.location}
        ownerId={draft.ownerId}
        payee={draft.payee}
        payeeSharePercent={draft.payeeSharePercent}
        onChange={update}
      />
      <PaymentMethodEditor value={draft.paymentMethod} onChange={(paymentMethod) => update({ paymentMethod })} />
      <label className="flex items-center gap-2 col-span-2 mt-1">
        <input type="checkbox" checked={draft.active} onChange={(e) => update({ active: e.target.checked })} />
        <span className="text-xs text-[var(--color-ink-muted)]">Active (paused bills stop generating new payments)</span>
      </label>

      <button onClick={onDelete} className="col-span-2 flex items-center gap-1 text-xs justify-self-start mt-1" style={{ color: 'var(--color-negative)' }}>
        <Trash2 size={13} /> Delete bill
      </button>

      <button
        onClick={() => onSave(draft)}
        className="col-span-2 w-full py-2.5 rounded-full text-sm font-semibold text-white mt-1"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
}

function BillForm({
  people,
  canBeJoint,
  categories,
  defaultOwnerId,
  initial,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  canBeJoint: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
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
  const [location, setLocation] = useState<BillLocation>(initial?.location ?? 'personal')
  const [payee, setPayee] = useState(initial?.payee || people[0]?.id || '')
  const [payeeSharePercent, setPayeeSharePercent] = useState(initial?.payeeSharePercent ?? 50)
  const [ownerId, setOwnerId] = useState(initial?.ownerId || defaultOwnerId)
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
        canBeJoint={canBeJoint}
        location={location}
        ownerId={ownerId}
        payee={payee}
        payeeSharePercent={payeeSharePercent}
        onChange={(patch) => {
          setLocation(patch.location)
          if (patch.ownerId) setOwnerId(patch.ownerId)
          if (patch.payee) setPayee(patch.payee)
          if (patch.payeeSharePercent !== undefined) setPayeeSharePercent(patch.payeeSharePercent)
        }}
      />

      <PaymentMethodEditor value={paymentMethod} onChange={setPaymentMethod} />

      <div className="flex gap-2 justify-end mt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm text-[var(--color-ink-muted)]">
          Cancel
        </button>
        <button
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
              ownerId: location === 'personal' ? ownerId : '',
            })
          }
          className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Add bill
        </button>
      </div>
    </div>
  )
}
