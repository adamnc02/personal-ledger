import { useRef, useState, type ReactNode } from 'react'

interface SwipeCardsProps {
  children: ReactNode[]
  activeIndex: number
  onChange: (index: number) => void
}

export function SwipeCards({ children, activeIndex, onChange }: SwipeCardsProps) {
  const startX = useRef<number | null>(null)
  const currentDelta = useRef(0)
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  const count = children.length

  function handlePointerDown(e: React.PointerEvent) {
    startX.current = e.clientX
    setIsDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (startX.current === null) return
    currentDelta.current = e.clientX - startX.current
    setDragOffset(currentDelta.current)
  }

  function handlePointerUp() {
    const threshold = 60
    if (currentDelta.current > threshold && activeIndex > 0) {
      onChange(activeIndex - 1)
    } else if (currentDelta.current < -threshold && activeIndex < count - 1) {
      onChange(activeIndex + 1)
    }
    startX.current = null
    currentDelta.current = 0
    setDragOffset(0)
    setIsDragging(false)
  }

  return (
    <div className="w-full">
      <div
        className="overflow-hidden touch-pan-y"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className="flex"
          style={{
            transform: `translateX(calc(${-activeIndex * 100}% + ${dragOffset}px))`,
            transition: isDragging ? 'none' : 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {children.map((child, i) => (
            <div key={i} className="w-full shrink-0 px-0.5">
              {child}
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-center gap-2 mt-4">
        {children.map((_, i) => (
          <button
            key={i}
            aria-label={`Go to card ${i + 1}`}
            onClick={() => onChange(i)}
            className="h-1.5 rounded-full transition-all duration-300"
            style={{
              width: i === activeIndex ? '20px' : '6px',
              background: i === activeIndex ? 'var(--color-coral)' : 'var(--color-track)',
            }}
          />
        ))}
      </div>
    </div>
  )
}
