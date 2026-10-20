/**
 * Where workspaces live between visits: a small async key-value adapter over records
 *
 *   { id, savedAt, revision, data }
 *
 * `data` is the serialized workspace; `revision` counts the writes of that workspace, so a
 * second tab can tell the stored copy moved on. Two implementations: IndexedDB for the browser
 * and an in-memory one for tests and for when IndexedDB is unavailable (private mode, some
 * `file://` contexts), in which case nothing survives the page and the app says so.
 *
 * @typedef {object} StoredWorkspace
 * @property {string} id
 * @property {number} savedAt Milliseconds since the epoch.
 * @property {number} revision
 * @property {unknown} data
 *
 * @typedef {object} WorkspaceStorage
 * @property {(id: string) => Promise<StoredWorkspace | undefined>} load
 * @property {(record: StoredWorkspace) => Promise<void>} save
 * @property {() => Promise<StoredWorkspace[]>} list
 * @property {(id: string) => Promise<void>} remove
 * @property {boolean} durable False for the in-memory fallback.
 */

const DB_NAME = "yourOffice";
const STORE = "workspaces";

/**
 * @returns {WorkspaceStorage}
 */
export function createMemoryStorage() {
  /** @type {Map<string, StoredWorkspace>} */
  const records = new Map();
  return {
    durable: false,
    load: async (id) => {
      const record = records.get(id);
      return record ? structuredClone(record) : undefined;
    },
    save: async (record) => void records.set(record.id, structuredClone(record)),
    list: async () => [...records.values()].map((record) => structuredClone(record)),
    remove: async (id) => void records.delete(id)
  };
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * @param {IDBFactory} factory
 * @param {string} name
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase(factory, name) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(name, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

/**
 * IndexedDB storage; the database is opened lazily, once, on first use.
 * @param {{ indexedDB?: IDBFactory, name?: string }} [options]
 * @returns {WorkspaceStorage}
 */
export function createIndexedDbStorage(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB is not available");
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;
  const db = () => (opening ??= openDatabase(factory, options.name ?? DB_NAME));

  /**
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest<T>} run
   * @returns {Promise<T>}
   */
  async function use(mode, run) {
    const tx = (await db()).transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    const [value] = await Promise.all([result(request), done(tx)]);
    return value;
  }

  return {
    durable: true,
    load: (id) => use("readonly", (store) => store.get(id)),
    save: async (record) => void (await use("readwrite", (store) => store.put(record))),
    list: () => use("readonly", (store) => store.getAll()),
    remove: async (id) => void (await use("readwrite", (store) => store.delete(id)))
  };
}

/**
 * IndexedDB when it works, otherwise memory. Opening is attempted up front so a browser that
 * exposes the API but refuses to use it (a `file://` page in some browsers) is found here and
 * not on the first save.
 * @param {{ indexedDB?: IDBFactory, name?: string }} [options]
 * @returns {Promise<{ storage: WorkspaceStorage, fallback: Error | null }>}
 */
export async function openStorage(options = {}) {
  try {
    const storage = createIndexedDbStorage(options);
    await storage.list();
    return { storage, fallback: null };
  } catch (error) {
    return { storage: createMemoryStorage(), fallback: error instanceof Error ? error : new Error(String(error)) };
  }
}
