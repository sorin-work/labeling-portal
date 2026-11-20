import { expect } from 'vitest';
import { configureAxe } from 'vitest-axe';

/**
 * The one axe check for every DOM test. Rules are only switched off here, and
 * each with its reason.
 */
const run = configureAxe({
  rules: {
    // jsdom computes no colours: contrast is checked against the stylesheet
    // in tests/unit/contrast.test.ts instead
    'color-contrast': { enabled: false },
  },
});

/** Fails the test with axe's own report when the markup has a violation. */
export async function expectAccessible(container: Element = document.body) {
  const results = await run(container);
  expect(results).toHaveNoViolations();
}
