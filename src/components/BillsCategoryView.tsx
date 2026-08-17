import { useState } from 'react'
import { Plus, Minus } from 'lucide-react'
import type { Bill } from '../types/models'
import { BillIcon } from './BillIcon'

interface BillsCategoryViewProps {
  bills: Bill[]
  total: number
}

export function BillsCategoryView({ bills, total }: BillsCategoryViewProps) {
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set())

  const groups = new Map<string, Bill[]>()
  for (const bill of bills) {
    const key = bill.category || 'Uncategorized'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(bill)
  }

  const sortedGroups = Array.from(groups.entries()).sort(
    ([, a], [, b]) => b.reduce((s, x) => s + x.cost, 0) - a.reduce((s, x) => s + x.cost, 0)
  )

  function toggle(category: string) {
    setOpenCategories((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  return (
    <div className="w-full">
      {sortedGroups.map(([category, categoryBills]) => {
        const categoryTotal = categoryBills.reduce((s, b) => s + b.cost, 0)
        const sorted = categoryBills.slice().sort((a, b) => b.cost - a.cost)
        const isOpen = openCategories.has(category)
        return (
          <div key={category} className="mb-2 last:mb-0">
            <button onClick={() => toggle(category)} className="w-full flex items-center justify-between py-2">
              <span className="flex items-center gap-2">
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-surface)', color: 'var(--color-coral)' }}
                >
                  {isOpen ? <Minus size={12} /> : <Plus size={12} />}
                </span>
                <span className="font-body text-sm font-semibold text-[var(--color-ink)]">{category}</span>
              </span>
              <span className="font-mono text-sm text-[var(--color-ink)]">£{categoryTotal.toFixed(2)}</span>
            </button>
            {isOpen && (
              <div className="pl-7 divide-y" style={{ borderColor: 'var(--color-track)' }}>
                {sorted.map((bill) => (
                  <div key={bill.id} className="flex items-center justify-between py-2">
                    <span className="flex items-center gap-2">
                      <BillIcon bill={bill} size={13} />
                      <span className="font-body text-xs text-[var(--color-ink-faint)]">{bill.name}</span>
                    </span>
                    <span className="font-mono text-xs text-[var(--color-ink-faint)] tabular-nums">£{bill.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="flex items-center justify-between pt-4 mt-1 border-t-2" style={{ borderColor: 'var(--color-ink-faint)' }}>
        <span className="font-display text-[15px] font-semibold text-[var(--color-ink)]">Total</span>
        <span className="font-mono text-[15px] font-semibold text-[var(--color-ink)] tabular-nums">£{total.toFixed(2)}</span>
      </div>
    </div>
  )
}
