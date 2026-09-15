// Real DOM interaction tests (not just pure-function checks) for
// SavingsPotForm — added 2026-09-02 after Adam reported a typed £10,000
// target amount silently becoming £9,990 on save. That specific value
// couldn't be reproduced with these three interaction patterns against
// the current, keyed field layout (see the "field key" bugfix comment in
// Salary.tsx) — every one round-trips the typed value correctly. Kept as
// a permanent regression suite rather than a throwaway repro: this is
// genuinely the only place in the app that empirically exercises typing
// into a form with conditionally-appearing/reordering siblings, which is
// exactly the class of bug that's easy to reintroduce and hard to catch
// by reading the code. `SavingsPotForm` is exported from Salary.tsx
// specifically so this file can render it directly.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SavingsPotForm } from './Salary'

afterEach(() => cleanup())

describe('SavingsPotForm repro — 10000 becoming 9990 on save', () => {
  it('types field-by-field in top-to-bottom order and checks what actually gets saved', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={[{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [], savingsEntries: [] }]} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)

    // "New pot" chooser first
    await user.click(screen.getByText(/New pot/))

    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    // Interest method defaults to aer_credited; leave it.
    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '4.5')
    // Credited defaults to monthly; leave it.
    await user.type(screen.getByLabelText('Monthly deposit (£, optional)'), '250')
    // On day of month now appears — leave default.
    await user.type(screen.getByLabelText('Target amount (£, optional)'), '10000')

    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))

    expect(onSave).toHaveBeenCalledTimes(1)
    const [, fields] = onSave.mock.calls[0]
    expect(fields.targetAmount).toBe(10000)
    expect(fields.recurringDepositAmount).toBe(250)
  })

  it('types Target amount BEFORE Monthly deposit — out of DOM order, the more realistic mobile-tap scenario', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={[{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [], savingsEntries: [] }]} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)
    await user.click(screen.getByText(/New pot/))
    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '4.5')
    // Target amount FIRST, while "On day of month" doesn't exist yet.
    await user.type(screen.getByLabelText('Target amount (£, optional)'), '10000')
    // THEN Monthly deposit — this makes "On day of month" appear, inserting a new sibling BETWEEN Monthly deposit and Target amount.
    await user.type(screen.getByLabelText('Monthly deposit (£, optional)'), '250')

    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))

    const [, fields] = onSave.mock.calls[0]
    expect(fields.targetAmount).toBe(10000)
  })

  it('edits On day of month AFTER Target amount is filled', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={[{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [], savingsEntries: [] }]} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)
    await user.click(screen.getByText(/New pot/))
    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '4.5')
    await user.type(screen.getByLabelText('Monthly deposit (£, optional)'), '250')
    await user.type(screen.getByLabelText('Target amount (£, optional)'), '10000')
    // Go back and edit On day of month AFTER target amount is already filled.
    const dayField = screen.getByLabelText('On day of month')
    await user.clear(dayField)
    await user.type(dayField, '14')

    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))

    const [, fields] = onSave.mock.calls[0]
    expect(fields.targetAmount).toBe(10000)
    expect(fields.recurringDepositDayOfMonth).toBe(14)
  })
})
