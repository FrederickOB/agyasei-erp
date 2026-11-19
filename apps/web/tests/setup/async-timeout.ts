/**
 * How long `findBy*` / `waitFor` wait before calling an element missing.
 *
 * The default is one second, which is a statement about the MACHINE, not the
 * product: `pnpm turbo run test` runs this suite beside the API's and the
 * database's PGlite suites, all at once, and on a loaded runner a lazy room
 * or a first local read can take longer than that to paint. A wait that
 * fails because the runner was busy is a flake, and a flaky suite trains
 * people to re-run red builds — the habit that lets a real failure through.
 *
 * Raising the ceiling changes no assertion: everything still has to appear,
 * and a test that passes still passes as soon as it does.
 */
import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: 8_000 });
