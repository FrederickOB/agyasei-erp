/**
 * The component-facing shape of a server read.
 *
 * `useLiveQuery` is the hook for everything on the device: it has no loading
 * state worth the name because a local read resolves in milliseconds. This is
 * its opposite number for the few things that live on the server (see
 * `data/api/client.ts` for which and why), and the difference is deliberately
 * visible in the type: a server read can be `loading`, it can be `slow`, and
 * it can FAIL — and a screen that does not handle the failure will not
 * compile past the switch.
 *
 * THREE RULES, ALL OF WHICH ARE ABOUT HONESTY RATHER THAN ERGONOMICS.
 *
 * 1. **A failed refresh discards the previous answer.** It is tempting to
 *    keep the last payload on screen while a refresh fails, and it is the
 *    wrong trade here: these figures are read at a counter and acted on. A
 *    stock figure from two hours ago, rendered exactly like a current one, is
 *    how somebody promises a customer cement that is not there. So the
 *    figures go and the reason takes their place.
 * 2. **`ready` carries `fetchedAtMs`.** Even a fresh answer is a SNAPSHOT of
 *    a server that other locations are still writing to, so the screen says
 *    when it was taken.
 * 3. **`slow` is a state, not a spinner.** Past a couple of seconds the
 *    screen stops pretending this is instant and says it is still trying, so
 *    a person can decide to stop waiting.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiFailure, ApiResult } from './client';

/** Past this, a request is described as still trying rather than as instant. */
export const SLOW_AFTER_MS = 2_500;

export type ApiQueryState<T> =
  | { readonly status: 'loading'; readonly slow: boolean }
  | { readonly status: 'ready'; readonly data: T; readonly fetchedAtMs: number }
  | { readonly status: 'failed'; readonly failure: ApiFailure };

export interface ApiQueryHandle<T> {
  readonly state: ApiQueryState<T>;
  /** Ask again. Clears the previous answer first — see rule 1 above. */
  readonly refresh: () => void;
}

export function useApiQuery<T>(
  run: () => Promise<ApiResult<T>>,
  deps: readonly unknown[],
): ApiQueryHandle<T> {
  const [state, setState] = useState<ApiQueryState<T>>({ status: 'loading', slow: false });
  const [attempt, setAttempt] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', slow: false });

    const slowTimer = setTimeout(() => {
      if (alive) setState((s) => (s.status === 'loading' ? { status: 'loading', slow: true } : s));
    }, SLOW_AFTER_MS);

    void runRef.current().then(
      (result) => {
        if (!alive) return;
        clearTimeout(slowTimer);
        setState(
          result.ok
            ? { status: 'ready', data: result.data, fetchedAtMs: result.fetchedAtMs }
            : { status: 'failed', failure: result.failure },
        );
      },
      (err: unknown) => {
        if (!alive) return;
        clearTimeout(slowTimer);
        // The call layer returns failures rather than throwing them, so a
        // rejection here is a defect in a mapper or a caller. It is still
        // shown as a refusal rather than left as a screen that never resolves.
        setState({
          status: 'failed',
          failure: {
            kind: 'malformed',
            message: 'This device could not complete the request.',
            detail: err instanceof Error ? err.message : String(err),
            status: null,
          },
        });
      },
    );

    return () => {
      alive = false;
      clearTimeout(slowTimer);
    };
    // The dependency list is explicit, exactly as in `useLiveQuery`: `run` is
    // a fresh closure on every render and would re-fire forever if listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, ...deps]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, refresh };
}
