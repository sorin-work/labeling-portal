import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as matchers from 'vitest-axe/matchers';

expect.extend(matchers);

// axe asks for a canvas to measure icon fonts; jsdom has none and says so on
// every call
HTMLCanvasElement.prototype.getContext = () => null;

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
