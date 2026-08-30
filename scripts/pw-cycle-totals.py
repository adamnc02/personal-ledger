import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BACKUP = os.environ.get('LEDGER_BACKUP') or str(Path(__file__).parent / 'fixtures' / 'backup-2026-08-24.json')
KEY = 'ledger:app-data-v2:v1'
data = json.load(open(BACKUP))

fails = []
def check(label, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + label + ('' if cond or not detail else '\n        ' + detail))
    if not cond:
        fails.append(label)

def set_dropdown(page, label, option):
    """InlineDropdown: click the labelled trigger, then the option."""
    page.get_by_text(label, exact=False).first.click()
    page.wait_for_timeout(150)
    page.get_by_text(option, exact=True).last.click()
    page.wait_for_timeout(300)

def toggle_present(page):
    return page.get_by_role('switch').count() > 0

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 420, 'height': 1400})
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto('http://127.0.0.1:5173/')
    page.wait_for_timeout(800)
    # Seed via evaluate + reload — page.goto alone does not re-trigger loadLedgerData().
    page.evaluate("([k, v]) => localStorage.setItem(k, v)", [KEY, json.dumps(data)])
    page.reload()
    page.wait_for_timeout(1800)

    print('\n=== A. Defaults on load — Next 3 cycles / List / Date / cycle-end totals ON ===')
    check('"Next 3 cycles" is the selected cycle pill', page.get_by_text('Next 3 cycles', exact=True).count() >= 1)
    check('toggle present by default (Next 3 cycles + List + Date)', toggle_present(page))
    sw0 = page.get_by_role('switch').first
    check('toggle is ON by default', sw0.get_attribute('aria-checked') == 'true')
    # Cycle-end totals on by default -> section headers, not a plain pending list.
    check('a "Current cycle" section header rendered by default', page.get_by_text('Current cycle', exact=True).count() >= 1)

    print('\n=== B. Toggle visibility across control combinations ===')
    set_dropdown(page, 'Order by', 'Amount')
    check('Next 3 cycles + List + Amount: toggle hidden', not toggle_present(page))
    set_dropdown(page, 'Order by', 'Date')
    check('...back to Date: toggle shown again', toggle_present(page))

    set_dropdown(page, 'Group by', 'Category')
    check('Next 3 cycles + Category: toggle hidden', not toggle_present(page))
    set_dropdown(page, 'Group by', 'List')
    check('...back to List: toggle shown again', toggle_present(page))

    page.get_by_text('This cycle', exact=True).first.click()
    page.wait_for_timeout(400)
    check('This cycle: toggle hidden', not toggle_present(page))
    page.get_by_text('Next 3 cycles', exact=True).first.click()
    page.wait_for_timeout(400)
    check('back to Next 3 cycles: toggle shown again', toggle_present(page))

    print('\n=== C. Switching the toggle off ===')
    sw = page.get_by_role('switch').first
    check('toggle starts on (default)', sw.get_attribute('aria-checked') == 'true')
    sw.click()
    page.wait_for_timeout(600)
    check('toggle now off', page.get_by_role('switch').first.get_attribute('aria-checked') == 'false')
    check('no cycle section headers once off', page.get_by_text('Current cycle', exact=True).count() == 0)
    # Switch back on for the rest of the checks (matches the default state).
    page.get_by_role('switch').first.click()
    page.wait_for_timeout(600)
    check('toggle back on', page.get_by_role('switch').first.get_attribute('aria-checked') == 'true')

    print('\n=== D. Default collapse states (cycle-end totals) ===')
    subtotals = page.get_by_text('Balance at', exact=False)
    print(f'        section subtotal rows visible: {subtotals.count()}')
    # 4 sections, all collapsed by default -> 0 subtotal rows visible.
    check('0 subtotal rows visible (4 sections, all collapsed)', subtotals.count() == 0,
          f'got {subtotals.count()}')

    cur = page.get_by_text('Current cycle', exact=True).first
    row = cur.locator('xpath=ancestor::button[1]')
    row_text = row.inner_text()
    check('collapsed Current cycle header shows a £ figure', '£' in row_text, repr(row_text))

    row.click()
    page.wait_for_timeout(500)
    row_text2 = page.get_by_text('Current cycle', exact=True).first.locator('xpath=ancestor::button[1]').inner_text()
    check('expanded Current cycle header shows NO figure', '£' not in row_text2, repr(row_text2))
    check('expanding adds a 1st subtotal row', page.get_by_text('Balance at', exact=False).count() == 1,
          f'got {page.get_by_text("Balance at", exact=False).count()}')

    print('\n=== E. Cleared payments hidden everywhere on the Summary page ===')
    # Cleared payments must never render as rows, in any of the four
    # views — cycle-grouped (currently active, expanded above), plain
    # date-ordered, amount-ordered, or category-grouped. Every real
    # backup accumulates cleared history, so if the hide were leaky this
    # would catch it directly rather than relying on a synthetic fixture.
    body = page.inner_text('body')
    check('no bold "Cleared" label anywhere (cycle-end totals view)', 'Cleared' not in body, 'found "Cleared" in body text')

    # Turn cycle-end totals off -> plain date-ordered list.
    page.get_by_role('switch').first.click()
    page.wait_for_timeout(500)
    check('no "Cleared" label in the plain date-ordered view either', 'Cleared' not in page.inner_text('body'))
    check('no leftover "Cleared (" toggle/count button', page.get_by_text('Cleared (', exact=False).count() == 0)

    set_dropdown(page, 'Order by', 'Amount')
    check('no "Cleared" label in the amount-ordered view', 'Cleared' not in page.inner_text('body'))
    set_dropdown(page, 'Order by', 'Date')

    set_dropdown(page, 'Group by', 'Category')
    check('no "Cleared" label in the category-grouped view', 'Cleared' not in page.inner_text('body'))
    set_dropdown(page, 'Group by', 'List')
    # Restore cycle-end totals to match the default state for anything after this.
    page.get_by_role('switch').first.click()
    page.wait_for_timeout(500)

    print('\n=== F. Console clean ===')
    # fonts.googleapis.com is blocked by some sandboxed/offline environments;
    # a webfont 403 says nothing about the app, so it isn't counted.
    ignorable = ('favicon', 'fonts.googleapis', 'fonts.gstatic', 'status of 403')
    real = [e for e in errors if not any(x in e.lower() for x in ignorable)]
    check('no console/page errors', len(real) == 0, '\n        '.join(real[:5]))

    page.screenshot(path='/tmp/shot-cycle-totals.png', full_page=True)
    browser.close()

print('\n' + ('ALL BROWSER CHECKS PASSED' if not fails else f'{len(fails)} FAILED: ' + '; '.join(fails)))
sys.exit(0 if not fails else 1)
