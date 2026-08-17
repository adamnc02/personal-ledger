import { Receipt } from 'lucide-react'
import { BILL_ICONS, DEFAULT_ICON_COLOR } from '../lib/billIcons'
import type { Bill } from '../types/models'

interface BillIconProps {
  bill: Pick<Bill, 'icon' | 'iconColor'>
  size?: number
}

export function BillIcon({ bill, size = 16 }: BillIconProps) {
  const Icon = (bill.icon && BILL_ICONS[bill.icon]) || Receipt
  const color = bill.icon ? bill.iconColor || DEFAULT_ICON_COLOR : 'var(--color-ink-faint)'
  return (
    <span className="inline-flex items-center justify-center shrink-0" style={{ width: size + 8, height: size + 8 }}>
      <Icon size={size} strokeWidth={1.75} style={{ color }} />
    </span>
  )
}
