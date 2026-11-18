/**
 * Async DOM assertions wait up to 5 s, not Testing Library's default 1 s.
 *
 * Why globally, when navigation.test.tsx once raised it for one test only:
 * that test was the first of a class, not an exception. Under
 * `turbo run test` — nineteen tasks contending for the CPU, and on CI
 * runners slower than any developer machine — a lazy chunk plus a PGlite or
 * wa-sqlite round trip routinely takes 1–3 s to render in jsdom, and by
 * November 2026 six files (office-shell, counter-ui, deliveries-ui,
 * receiving-ui, reports-ui, printing-ui) flaked that way while passing every
 * time on their own. A suite that fails at random teaches people to re-run
 * it, which is how a real failure gets re-run away.
 *
 * What is under test in these files is behaviour (the cart survives
 * navigation, a refusal is shown), never milliseconds: jsdom is not the
 * device, and render-time budgets belong to the real-browser harness on the
 * target hardware (§8.10). A genuine hang still fails — at 5 s instead of 1.
 *
 * A no-op for files that never load @testing-library (environment 'node').
 */
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });
