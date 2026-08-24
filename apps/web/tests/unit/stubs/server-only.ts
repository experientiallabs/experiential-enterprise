// Vitest runs outside a React Server environment, where the real
// `server-only` marker throws on import by design. The alias in
// vitest.config.ts points here so server-only modules stay unit-testable.
export {};
