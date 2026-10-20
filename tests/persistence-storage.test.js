import { describe, expect, it } from "vitest";
import { createIndexedDbStorage, createMemoryStorage, openStorage } from "../src/persistence/storage.js";

const record = (id, revision = 1) => ({ id, savedAt: 10, revision, data: { n: revision } });

/** Just enough IndexedDB for the adapter: one store, keyPath "id", requests that settle asynchronously. */
function fakeIndexedDB({ failOpen = false } = {}) {
  const rows = new Map();
  const later = (fn) => queueMicrotask(fn);
  const request = (run) => {
    const req = { result: undefined, error: null };
    later(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
    return req;
  };
  const objectStore = (tx) => ({
    get: (id) => finish(tx, request(() => rows.get(id))),
    getAll: () => finish(tx, request(() => [...rows.values()])),
    put: (value) => finish(tx, request(() => void rows.set(value.id, structuredClone(value)))),
    delete: (id) => finish(tx, request(() => void rows.delete(id)))
  });
  const finish = (tx, req) => {
    later(() => later(() => tx.oncomplete?.()));
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: () => {
      const tx = {};
      tx.objectStore = () => objectStore(tx);
      return tx;
    }
  };
  return {
    rows,
    open: () => {
      const req = { result: db };
      later(() => {
        if (failOpen) {
          req.error = new Error("denied");
          req.onerror?.();
        } else {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }
      });
      return req;
    }
  };
}

describe("memory storage", () => {
  it("saves, loads, lists and removes copies, not references", async () => {
    const storage = createMemoryStorage();
    const original = record("a");
    await storage.save(original);
    original.data.n = 99;
    expect((await storage.load("a")).data.n).toBe(1);
    await storage.save(record("b", 2));
    expect((await storage.list()).map((r) => r.id).sort()).toEqual(["a", "b"]);
    await storage.remove("a");
    expect(await storage.load("a")).toBeUndefined();
    expect(storage.durable).toBe(false);
  });
});

describe("IndexedDB storage", () => {
  it("round-trips records through the store", async () => {
    const idb = fakeIndexedDB();
    const storage = createIndexedDbStorage({ indexedDB: idb });
    await storage.save(record("a", 3));
    expect((await storage.load("a")).revision).toBe(3);
    expect(await storage.list()).toHaveLength(1);
    await storage.remove("a");
    expect(idb.rows.size).toBe(0);
    expect(storage.durable).toBe(true);
  });

  it("openStorage uses it when it opens", async () => {
    const { storage, fallback } = await openStorage({ indexedDB: fakeIndexedDB() });
    expect(storage.durable).toBe(true);
    expect(fallback).toBeNull();
  });

  it("openStorage falls back to memory, saying why, when IndexedDB is missing or refuses", async () => {
    const refused = await openStorage({ indexedDB: fakeIndexedDB({ failOpen: true }) });
    expect(refused.storage.durable).toBe(false);
    expect(refused.fallback?.message).toBe("denied");
    const missing = await openStorage({ indexedDB: undefined });
    expect(missing.storage.durable).toBe(false);
    expect(missing.fallback).toBeInstanceOf(Error);
  });
});
