import { useState } from 'react'
import { formatCurrency } from '../lib/format'
import { Plus, X } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { EditField } from './EditField'
import { INCOME_CATEGORY_ID } from '../types/ledger'
import { resolvePayday } from '../lib/payCycle'
import { computeNetBonusAmount } from '../lib/salaryLedger'

import { toLocalIsoDate as toIso } from '../lib/date'

/** The nearest upcoming payday for this ledger person, used only as a sensible default date — the transaction itself isn't mechanically linked to the generated salary transaction in any way (confirmed: a bonus is just a plain incoming amount, same as logging it from the Expenses page). */
function nearestUpcomingPayday(personId: string, ledgerData: ReturnType<typeof useLedgerData>['data']): string {
  const payCycle = ledgerData.payCycles.find((pc) => pc.personId === personId)
  const today = new Date()
  if (!payCycle) return toIso(today)
  const thisMonth = resolvePayday(today.getFullYear(), today.getMonth(), payCycle.paydayDayOfMonth, payCycle.paydayAdjustForNonWorkingDay)
  if (thisMonth >= today) return toIso(thisMonth)
  const nextMonth = resolvePayday(today.getFullYear(), today.getMonth() + 1, payCycle.paydayDayOfMonth, payCycle.paydayAdjustForNonWorkingDay)
  return toIso(nextMonth)
}

/**
 * personId is a real ledger Person id — the Salary page now runs on the
 * ledger model directly, so there's no longer a need to bridge between
 * two different Person id spaces by matching names.
 */
export function AttachBonusButton({ personId, fixedDate }: { personId: string; fixedDate?: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button onClick={() => setOpen(true)} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--color-coral)' }}>
        <Plus size={12} /> Bonus
      </button>
      {open && <AttachBonusForm personId={personId} fixedDate={fixedDate} onClose={() => setOpen(false)} />}
    </>
  )
}

function AttachBonusForm({ personId, fixedDate, onClose }: { personId: string; fixedDate?: string; onClose: () => void }) {
  const { data, addAdHocTransaction } = useLedgerData()
  const [grossAmount, setGrossAmount] = useState('')
  const [date, setDate] = useState(() => fixedDate ?? nearestUpcomingPayday(personId, data))
  const [note, setNote] = useState('')
  const grossNumber = Number(grossAmount)

  const person = data.people.find((p) => p.id === personId)
  const netAmount = person && grossNumber > 0 ? computeNetBonusAmount(person, date, grossNumber) : null

  return (
    <div className="mt-3 rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-ink)]">Attach a bonus to a pay</span>
        <button onClick={onClose} className="text-[var(--color-ink-muted)]">
          <X size={14} />
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-ink-faint)] -mt-1">
        Enter the gross bonus — tax, NI, and student loan are worked out at your marginal rate for this pay date, same
        as your salary. The taxed amount logs as a plain incoming transaction; it doesn't change your computed salary
        figure itself.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Gross bonus (£)" type="number" value={grossAmount} onChange={setGrossAmount} />
        {fixedDate ? (
          <div>
            <span className="text-xs text-[var(--color-ink-muted)] block mb-1">Pay date</span>
            <span className="text-sm text-[var(--color-ink)]">{fixedDate}</span>
          </div>
        ) : (
          <EditField label="Pay date" type="date" value={date} onChange={setDate} />
        )}
      </div>
      {grossNumber > 0 && (
        <p className="text-xs text-[var(--color-ink)]">
          {netAmount === null ? (
            <span className="text-[var(--color-ink-faint)]">No salary set up for this date yet — can't estimate tax.</span>
          ) : (
            <>
              You'll receive <span className="font-semibold">£{formatCurrency(netAmount)}</span> after tax, NI &amp; student loan
              {netAmount < grossNumber && <span className="text-[var(--color-ink-faint)]"> (£{formatCurrency(grossNumber - netAmount)} deducted)</span>}
            </>
          )}
        </p>
      )}
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <button
        disabled={!(grossNumber > 0 && date && netAmount !== null && netAmount > 0)}
        onClick={() => {
          if (netAmount === null) return
          addAdHocTransaction({
            type: 'bonus',
            amount: netAmount,
            date,
            categoryId: INCOME_CATEGORY_ID,
            paymentMethod: 'bank_transfer',
            personId,
            note: note ? `${note} (gross £${formatCurrency(grossNumber)})` : `Gross £${formatCurrency(grossNumber)}`,
          })
          onClose()
        }}
        className="self-end px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Attach
      </button>
    </div>
  )
}
