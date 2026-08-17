import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { BILL_ICONS, ICON_COLORS, DEFAULT_ICON_COLOR } from '../lib/billIcons'
import { BillIcon } from './BillIcon'

interface IconPickerButtonProps {
  icon?: string
  iconColor?: string
  onChange: (patch: { icon?: string; iconColor?: string }) => void
}

/**
 * A single compact button showing the current icon; tapping it opens a
 * bottom-sheet modal with the full icon grid and color palette. Replaces an
 * earlier version that showed all 34 icons + 10 colors inline in the form
 * at all times — fine for one bill, overwhelming as a permanent fixture.
 *
 * Rendered via a portal straight to document.body rather than inline in the
 * component tree: the app shell has several nested position/overflow
 * containers (see App.tsx), and an inline fixed-position modal could end up
 * stacked or clipped relative to one of those rather than the true
 * viewport — a portal sidesteps that entirely rather than fighting it.
 */
export function IconPickerButton({ icon, iconColor, onChange }: IconPickerButtonProps) {
  const [open, setOpen] = useState(false)
  const color = iconColor || DEFAULT_ICON_COLOR

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Icon</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-11 h-11 rounded-full flex items-center justify-center border"
          style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-track)' }}
        >
          <BillIcon bill={{ icon, iconColor }} size={18} />
        </button>
      </div>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[500] flex items-end justify-center"
            style={{ background: 'rgba(0,0,0,0.55)' }}
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-md rounded-t-3xl p-5 max-h-[75vh] overflow-y-auto"
              style={{
                background: 'var(--color-surface)',
                // Clears the floating nav's actual footprint, not just the
                // safe-area — otherwise the Done button sits right behind it.
                paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Choose an icon</h3>
                <button onClick={() => setOpen(false)} className="text-[var(--color-ink-muted)]">
                  <X size={20} />
                </button>
              </div>

              <div className="flex flex-wrap gap-2 mb-5">
                <button
                  onClick={() => onChange({ icon: undefined })}
                  className="w-11 h-11 rounded-full flex items-center justify-center text-[10px] font-medium"
                  style={{
                    background: !icon ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                    color: !icon ? '#fff' : 'var(--color-ink-faint)',
                  }}
                >
                  none
                </button>
                {Object.entries(BILL_ICONS).map(([key, Icon]) => (
                  <button
                    key={key}
                    onClick={() => onChange({ icon: key, iconColor: iconColor ?? DEFAULT_ICON_COLOR })}
                    className="w-11 h-11 rounded-full flex items-center justify-center"
                    style={{ background: icon === key ? 'var(--color-coral)' : 'var(--color-bg-elevated)' }}
                    title={key.replace('_', ' ')}
                  >
                    <Icon size={18} style={{ color: icon === key ? '#fff' : color }} />
                  </button>
                ))}
              </div>

              {icon && (
                <>
                  <h4 className="text-xs text-[var(--color-ink-muted)] mb-2">Colour</h4>
                  <div className="flex flex-wrap gap-2">
                    {ICON_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => onChange({ iconColor: c })}
                        className="w-9 h-9 rounded-full"
                        style={{
                          background: c,
                          outline: color === c ? '2px solid var(--color-ink)' : '1px solid var(--color-track)',
                          outlineOffset: 2,
                        }}
                      />
                    ))}
                  </div>
                </>
              )}

              <button
                onClick={() => setOpen(false)}
                className="w-full mt-5 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'var(--color-coral)', color: '#fff' }}
              >
                Done
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
