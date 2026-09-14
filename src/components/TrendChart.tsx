// Trends feature (2026-09-15 build) — the two interactive chart styles:
// BalanceSpendChart (line/area, Personal/Joint/Household/Credit Card/Pot)
// and SavingsPotPillChart (vertical columns, Savings Pot only). Both hand-
// roll their own scale/path math and pointer-event gesture handling rather
// than reaching for a charting library's own tooltip/trigger system — see
// the Trends prompt doc's own "Library recommendation" section for why:
// the tap-and-hold-then-drag-between-points gesture with all-other-points-
// blur is bespoke, and no mainstream library (Recharts/visx/Chart.js/Nivo)
// ships it as a built-in trigger mode.
//
// DEVIATION FLAGGED (prompt doc explicitly allows this as the documented
// fallback, "call this out explicitly... but don't block on asking
// first"): this build uses NO new dependency at all (not even
// @visx/scale/@visx/shape or d3-scale/d3-shape) — every bit of scale and
// path math below is plain arithmetic against an SVG viewBox. The doc's
// stated default was to add the small visx/d3 primitives; this fallback
// (explicitly pre-approved, zero new deps) was chosen instead to keep the
// build self-contained without an extra install/lockfile step.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatCurrency } from '../lib/format'
import type { BalanceSpendTrendSeries, DailyBalancePoint } from '../lib/runningBalance'
import type { SavingsPotPillPoint, SavingsPotTrendSeries } from '../lib/savingsPotLedger'

// ── Shared formatting ───────────────────────────────────────────────────

/** Axis-label money formatting matching the reference screenshots exactly: plain whole pounds under £1,000 ("£527", "-£115"), abbreviated to one decimal place in thousands at/above it ("£1.3K") — NOT the 2-decimal-pence formatting formatCurrency uses for headline figures. */
export function formatAxisMoney(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1000) return `${sign}£${(abs / 1000).toFixed(1)}K`
  return `${sign}£${Math.round(abs)}`
}

function shortDayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${MONTHS[m - 1]}`
}

// ── Balance/Spend line-area chart ──────────────────────────────────────

export type BalanceSpendView = 'balance' | 'spend'

export interface BalanceSpendChartProps {
  series: BalanceSpendTrendSeries
  view: BalanceSpendView
  color: string
  /** Non-interactive small preview (Trends section, inline per card) vs the full interactive chart (TrendsModal) — no tap-and-hold/tooltip/axis labels in preview mode, per the prompt doc's own "small... non-interactive, no tap-and-hold/tooltip behaviour here" spec for the inline section. */
  interactive?: boolean
  height?: number
  /** Icon-only tooltip content for transactions on a given day, e.g. category icons for that date — rendered by the caller, since only Home.tsx knows how to resolve a category to an icon component. */
  dayIcons?: (dateIso: string) => { key: string; node: React.ReactNode }[]
}

const WIDTH = 320

function scaleX(i: number, count: number): number {
  return count <= 1 ? 0 : (i / (count - 1)) * WIDTH
}

function makeYScale(values: number[], height: number, padTop: number, padBottom: number) {
  const min = Math.min(0, ...values)
  const max = Math.max(...values, min + 1)
  const span = max - min || 1
  return (v: number) => padTop + (1 - (v - min) / span) * (height - padTop - padBottom)
}

function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

function areaPath(points: { x: number; y: number }[], baselineY: number): string {
  if (points.length === 0) return ''
  const top = linePath(points)
  const last = points[points.length - 1]
  const first = points[0]
  return `${top} L${last.x.toFixed(1)},${baselineY.toFixed(1)} L${first.x.toFixed(1)},${baselineY.toFixed(1)} Z`
}

export function BalanceSpendChart({ series, view, color, interactive = false, height = 200, dayIcons }: BalanceSpendChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)

  const days = series.days
  const todayIdx = days.indexOf(series.todayIso)
  const splitIdx = todayIdx === -1 ? days.length - 1 : todayIdx

  const padTop = interactive ? 24 : 6
  const padBottom = interactive ? 22 : 4
  const padRight = interactive ? 44 : 2

  let solidPoints: { x: number; y: number; date: string; value: number }[] = []
  let dottedPoints: { x: number; y: number; date: string; value: number }[] = []
  let comparePoints: { x: number; y: number }[] = []
  let allValues: number[] = []

  if (view === 'balance') {
    allValues = series.balance.flatMap((b) => [b.clearedBalance, b.projectedBalance])
    const yScale = makeYScale(allValues, height, padTop, padBottom)
    const toPoint = (b: DailyBalancePoint, i: number, useProjected: boolean) => ({
      x: scaleX(i, days.length),
      y: yScale(useProjected ? b.projectedBalance : b.clearedBalance),
      date: b.date,
      value: useProjected ? b.projectedBalance : b.clearedBalance,
    })
    solidPoints = series.balance.slice(0, splitIdx + 1).map((b, i) => toPoint(b, i, false))
    dottedPoints = series.balance.slice(splitIdx).map((b, i) => toPoint(b, i + splitIdx, true))
  } else {
    allValues = [...series.spend.map((s) => s.spendToDate), ...series.previousPeriodSpend.map((s) => s.spendToDate)]
    const yScale = makeYScale(allValues, height, padTop, padBottom)
    solidPoints = series.spend.slice(0, splitIdx + 1).map((s, i) => ({ x: scaleX(i, days.length), y: yScale(s.spendToDate), date: s.date, value: s.spendToDate }))
    dottedPoints = series.spend.slice(splitIdx).map((s, i) => ({ x: scaleX(i + splitIdx, days.length), y: yScale(s.spendToDate), date: s.date, value: s.spendToDate }))
    comparePoints = series.previousPeriodSpend.map((s, i) => ({ x: scaleX(i, days.length), y: yScale(s.spendToDate) }))
  }

  const baselineY = makeYScale(allValues, height, padTop, padBottom)(Math.min(0, ...allValues))

  function hitTest(clientX: number) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const relX = ((clientX - rect.left) / rect.width) * WIDTH
    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < days.length; i++) {
      const x = scaleX(i, days.length)
      const dist = Math.abs(x - relX)
      if (dist < closestDist) {
        closestDist = dist
        closest = i
      }
    }
    setActiveIndex(closest)
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return
    dragging.current = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    hitTest(e.clientX)
  }
  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive || !dragging.current) return
    hitTest(e.clientX)
  }
  function endGesture() {
    dragging.current = false
    setActiveIndex(null)
  }

  const activeDate = activeIndex !== null ? days[activeIndex] : null
  const activeValue =
    activeIndex !== null ? (view === 'balance' ? (activeIndex <= splitIdx ? series.balance[activeIndex].clearedBalance : series.balance[activeIndex].projectedBalance) : series.spend[activeIndex]?.spendToDate) : null

  return (
    <div style={{ position: 'relative' }}>
      {interactive && activeIndex !== null && activeDate !== null && (
        <div
          className="absolute left-0 right-0 top-0 flex items-center justify-between px-3 py-2 rounded-2xl"
          style={{ background: 'var(--color-bg-elevated)', zIndex: 2 }}
          data-testid="trend-tooltip"
        >
          <div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">{shortDayLabel(activeDate)}</p>
            {dayIcons && dayIcons(activeDate).length > 0 && (
              <div className="flex items-center gap-1 mt-0.5">
                {dayIcons(activeDate).map((ic) => (
                  <span key={ic.key}>{ic.node}</span>
                ))}
              </div>
            )}
          </div>
          <p className="text-lg font-mono font-semibold text-[var(--color-ink)]">£{formatCurrency(activeValue ?? 0)}</p>
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH + padRight} ${height}`}
        width="100%"
        height={height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={endGesture}
        style={{ touchAction: interactive ? 'none' : undefined, display: 'block' }}
      >
        {interactive && (
          <>
            <line x1={0} y1={padTop} x2={WIDTH} y2={padTop} stroke="var(--color-track)" strokeWidth={1} />
            <line x1={0} y1={height - padBottom} x2={WIDTH} y2={height - padBottom} stroke="var(--color-track)" strokeWidth={1} />
          </>
        )}

        {view === 'spend' && (
          <path d={areaPath(solidPoints, baselineY)} fill={color} opacity={activeIndex !== null ? 0.08 : 0.16} />
        )}
        {view === 'spend' && comparePoints.length > 1 && (
          <path d={linePath(comparePoints)} fill="none" stroke="var(--color-ink-faint)" strokeWidth={1.5} strokeDasharray="3,3" opacity={0.7} />
        )}

        <path
          d={linePath(solidPoints)}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          opacity={activeIndex !== null && activeIndex > splitIdx ? 0.3 : 1}
        />
        {dottedPoints.length > 1 && (
          <path d={linePath(dottedPoints)} fill="none" stroke="var(--color-ink-faint)" strokeWidth={2} strokeDasharray="4,4" />
        )}

        {activeIndex !== null && (
          <>
            <line x1={scaleX(activeIndex, days.length)} y1={padTop} x2={scaleX(activeIndex, days.length)} y2={height - padBottom} stroke={color} strokeWidth={1.5} strokeDasharray="3,3" />
            <circle cx={scaleX(activeIndex, days.length)} cy={activeIndex <= splitIdx ? solidPoints[activeIndex]?.y : dottedPoints[activeIndex - splitIdx]?.y} r={5} fill="var(--color-bg-elevated)" stroke={color} strokeWidth={2.5} />
          </>
        )}
        {activeIndex === null && solidPoints.length > 0 && (
          <circle cx={solidPoints[solidPoints.length - 1].x} cy={solidPoints[solidPoints.length - 1].y} r={5} fill="var(--color-bg-elevated)" stroke={color} strokeWidth={2.5} />
        )}

        {interactive && (
          <>
            <text x={0} y={height - 4} fontSize={11} fill="var(--color-ink-faint)">{shortDayLabel(days[0])}</text>
            <text x={WIDTH} y={height - 4} fontSize={11} fill="var(--color-ink-faint)" textAnchor="end">{shortDayLabel(days[days.length - 1])}</text>
            <text x={WIDTH + padRight - 2} y={padTop + 4} fontSize={11} fill="var(--color-ink-faint)" textAnchor="end">{formatAxisMoney(Math.max(...allValues))}</text>
            <text x={WIDTH + padRight - 2} y={height - padBottom} fontSize={11} fill="var(--color-ink-faint)" textAnchor="end">{formatAxisMoney(Math.min(0, ...allValues))}</text>
          </>
        )}
      </svg>
    </div>
  )
}

// ── Savings Pot pill/column chart ──────────────────────────────────────

export interface SavingsPotPillChartProps {
  series: SavingsPotTrendSeries
  color: string
  interactive?: boolean
  height?: number
  /** Rendered over the card's own callout/header area, per the prompt doc ("tooltip renders over the callout section... not floating next to the tapped column") — the caller (SavingsPotDetail/TrendsModal) owns that placement; this component just reports which point is active via this callback. */
  onActivePointChange?: (point: SavingsPotPillPoint | null) => void
}

export function SavingsPotPillChart({ series, color, interactive = false, height = 140, onActivePointChange }: SavingsPotPillChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)

  const points = series.points
  const values = points.map((p) => p.endBalance)
  const min = Math.min(0, ...values)
  const max = Math.max(...values, min + 1)
  const span = max - min || 1
  const padTop = 4
  const padBottom = interactive ? 18 : 2
  const barGap = 3
  const barWidth = points.length > 0 ? Math.max(2, WIDTH / points.length - barGap) : 4

  function barHeight(v: number) {
    return ((v - min) / span) * (height - padTop - padBottom)
  }

  // Cap x-axis LABELS at 4 even though every column still renders — per
  // the prompt doc's own table ("Both Savings Pot's 'This Cycle'/'Last 6
  // Cycles' groupings cap x-axis labels at 4 even when more columns
  // render").
  const labelIndices = new Set<number>()
  if (points.length > 0) {
    const maxLabels = Math.min(4, points.length)
    for (let i = 0; i < maxLabels; i++) {
      labelIndices.add(Math.round((i / Math.max(1, maxLabels - 1)) * (points.length - 1)))
    }
  }

  function hitTest(clientX: number) {
    const svg = svgRef.current
    if (!svg || points.length === 0) return
    const rect = svg.getBoundingClientRect()
    const relX = ((clientX - rect.left) / rect.width) * WIDTH
    const idx = Math.min(points.length - 1, Math.max(0, Math.floor(relX / (barWidth + barGap))))
    setActiveIndex(idx)
    onActivePointChange?.(points[idx])
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return
    dragging.current = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    hitTest(e.clientX)
  }
  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive || !dragging.current) return
    hitTest(e.clientX)
  }
  function endGesture() {
    dragging.current = false
    setActiveIndex(null)
    onActivePointChange?.(null)
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${height}`}
      width="100%"
      height={height}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={endGesture}
      style={{ touchAction: interactive ? 'none' : undefined, display: 'block' }}
    >
      {points.map((p, i) => {
        const h = Math.max(2, barHeight(p.endBalance))
        const x = i * (barWidth + barGap)
        const y = height - padBottom - h
        const isActive = activeIndex === i
        return (
          <g key={`${p.periodStart}-${i}`}>
            <rect x={x} y={y} width={barWidth} height={h} rx={barWidth / 2} fill={color} opacity={activeIndex === null || isActive ? 1 : 0.3} />
            {interactive && labelIndices.has(i) && (
              <text x={x + barWidth / 2} y={height - 4} fontSize={9} textAnchor="middle" fill="var(--color-ink-faint)">
                {p.axisLabel}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
