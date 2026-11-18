/**
 * Where the device's identity lives between page loads: IndexedDB, because a
 * non-extractable CryptoKey can only be persisted by structured clone, and
 * IndexedDB is where structured clone goes (§2.7).
 *
 * Per DEVICE, never per user (08 §8.1a): one device record (its key, its
 * enrolment), and one record per user who has signed in here (their wrapped
 * key, their sealed refresh credential, their last verified lease). A shift
 * change is an unlock, not a re-download, and logging out never deletes
 * anything — only a server-acknowledged revocation drain wipes (§2.7).
 */

export interface AuthStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  /** Everything — the wipe. Only after a drain the server acknowledged. */
  clear(): Promise<void>;
}

export function memoryStore(): AuthStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => {
      m.delete(k);
    },
    keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)),
    clear: async () => {
      m.clear();
    },
  };
}

const DB_NAME = 'erp-device-identity';
const STORE = 'kv';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export function indexedDbStore(): AuthStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      });
    }
    return dbp;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    get: async <T,>(k: string) => (await request((await tx('readonly')).get(k))) as T | undefined,
    set: async (k, v) => {
      await request((await tx('readwrite')).put(v, k));
    },
    delete: async (k) => {
      await request((await tx('readwrite')).delete(k));
    },
    keys: async (prefix) =>
      ((await request((await tx('readonly')).getAllKeys())) as IDBValidKey[])
        .map(String)
        .filter((k) => k.startsWith(prefix)),
    clear: async () => {
      await request((await tx('readwrite')).clear());
    },
  };
}
