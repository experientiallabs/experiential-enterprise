// Pin a non-UTC zone before any Intl use so hydration-swap tests (UTC server
// snapshot vs browser zone) assert a real difference even on UTC CI runners.
process.env.TZ = "America/New_York";

import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; useMeasuredSize consumers (ImprovementChart)
// render with it and gate on the synchronous first measurement instead.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no matchMedia; responsive-gated components (CreditsWelcome) read it
// to decide whether their surface is visible. Default to a matched (desktop)
// query; a test that needs the narrow branch overrides window.matchMedia.
class MediaQueryListStub {
  matches = true;
  onchange = null;
  constructor(public media: string) {}
  addEventListener() {}
  removeEventListener() {}
  addListener() {}
  removeListener() {}
  dispatchEvent() {
    return false;
  }
}
globalThis.matchMedia ??= ((query: string) =>
  new MediaQueryListStub(query)) as unknown as typeof matchMedia;
