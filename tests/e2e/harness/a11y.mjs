// Accessibility check for the e2e suite: axe-core with the WCAG 2 A + AA rule tags. Specs call
// `expectAccessible(page)` once per screen state (light and dark); only serious and critical
// findings fail, so a moderate best-practice nit never blocks a run.
import { AxeBuilder } from '@axe-core/playwright';
import { expect } from '@playwright/test';

const FAILING_IMPACTS = new Set(['serious', 'critical']);

/**
 * The serious/critical WCAG 2 A/AA violations on the page right now.
 * @param {import('@playwright/test').Page} page
 * @param {{ exclude?: string[] }} [opts] CSS selectors to leave out of the scan.
 */
export async function seriousViolations(page, { exclude = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  return violations.filter((v) => FAILING_IMPACTS.has(v.impact));
}

/** Fail the test if the page has any serious or critical WCAG 2 A/AA violation. */
export async function expectAccessible(page, { exclude = [] } = {}) {
  const found = await seriousViolations(page, { exclude });
  const report = found.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help} — ${v.nodes
        .slice(0, 5)
        .map((n) => n.target.join(' '))
        .join(', ')}`,
  );
  expect(report, 'serious/critical accessibility violations').toEqual([]);
}
