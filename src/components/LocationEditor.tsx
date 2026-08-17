import { SplitEditor } from './SplitEditor'
import type { BillLocation } from '../types/models'

/**
 * The "Joint" option is only shown once a second person exists AND that
 * second person actually has a salary configured — with only one real
 * income there is nothing to split a joint item against, so offering it
 * was a real bug (doc feedback: "I can still see the option to select
 * joint account even with only one salary"). `canBeJoint` is computed by
 * the caller (who has access to the full Person list with salaryHistory,
 * or the legacy equivalent) via `hasSalaryConfigured`/`peopleWithSalaryCount`
 * in lib/household.ts, rather than derived here from a narrowed
 * `{id, name}[]` shape that can't see salary data.
 *
 * If the location was somehow already 'joint' (e.g. the second person or
 * their salary was later removed), this still displays the current value
 * correctly but the select won't offer switching back to it as a fresh
 * choice — onChange's caller should ideally have migrated it back to
 * 'personal' at that point (see LedgerContext.removePerson, which doesn't
 * currently reassign existing joint items — a known follow-up).
 */
export function LocationEditor({
  people,
  canBeJoint,
  location,
  ownerId,
  payee,
  payeeSharePercent,
  onChange,
}: {
  people: { id: string; name: string }[]
  canBeJoint: boolean
  location: BillLocation
  ownerId: string
  payee: string
  payeeSharePercent: number
  onChange: (patch: { location: BillLocation; ownerId?: string; payee?: string; payeeSharePercent?: number }) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Location</span>
        {canBeJoint ? (
          <select
            value={location}
            onChange={(e) => {
              const next = e.target.value as BillLocation
              onChange(
                next === 'joint'
                  ? { location: next, payee: payee || people[0]?.id || '' }
                  : { location: next, ownerId: ownerId || people[0]?.id || '' },
              )
            }}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="personal" style={{ color: '#000' }}>
              Personal
            </option>
            <option value="joint" style={{ color: '#000' }}>
              Joint
            </option>
          </select>
        ) : (
          <span className="text-sm text-[var(--color-ink-faint)] py-1">Personal (add a second person's salary on the Salary page to split costs)</span>
        )}
      </label>
      {location === 'personal' && people.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Owner</span>
          <select
            value={ownerId}
            onChange={(e) => onChange({ location, ownerId: e.target.value })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {location === 'joint' && canBeJoint && (
        <SplitEditor
          people={people}
          payee={payee || people[0]?.id || ''}
          percent={payeeSharePercent}
          onChangePayee={(p) => onChange({ location, payee: p })}
          onChangePercent={(pct) => onChange({ location, payeeSharePercent: pct })}
        />
      )}
    </div>
  )
}
