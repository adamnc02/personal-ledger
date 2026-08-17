interface ProgressRingProps {
  percent: number // 0-100, how much of the ring should be filled
  size?: number
  strokeWidth?: number
  color?: string
  trackColor?: string
  icon?: React.ReactNode
  value: string
  label: string
}

export function ProgressRing({
  percent,
  size = 220,
  strokeWidth = 22,
  color = 'var(--color-coral)',
  trackColor = 'var(--color-track)',
  icon,
  value,
  label,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, percent))
  const offset = circumference - (clamped / 100) * circumference

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        </svg>
        {icon && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ color }}>
            {icon}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-1">
        <span className="font-display text-3xl font-semibold text-[var(--color-ink)] tabular-nums">{value}</span>
        <span className="font-body text-sm text-[var(--color-ink-muted)] tracking-wide">{label}</span>
      </div>
    </div>
  )
}
