interface EditFieldProps {
  label: string
  value: string | number
  onChange: (v: string) => void
  type?: string
}

export function EditField({ label, value, onChange, type = 'text' }: EditFieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-ink-muted)]">{label}</span>
      <input
        type={type}
        // iOS shows the full alphabetic keyboard for type="number" unless
        // told otherwise — inputMode is what actually picks the decimal pad.
        inputMode={type === 'number' ? 'decimal' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
      />
    </label>
  )
}
