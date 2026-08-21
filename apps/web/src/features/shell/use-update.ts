import { useEffect, useState } from 'react';
import { isUpdateReady, subscribeUpdateReady } from '../../sw/register';

/** React view of the waiting-service-worker flag (§8.11). */
export function useUpdateReady(): boolean {
  const [ready, setReady] = useState<boolean>(isUpdateReady());
  useEffect(() => subscribeUpdateReady(() => setReady(true)), []);
  return ready;
}
