import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createMemoryStorage } from "../src/persistence/storage.js";
import { attachPageLifecycle, createAutosave } from "../src/persistence/autosave.js";

const edit = (ws, title) => ws.dispatch("renameWorkspace", { title });
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("autosave", () => {
  it("writes a new workspace once it has been quiet for a second", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    const autosave = createAutosave(ws, storage);
    expect(autosave.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(await storage.load(ws.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    const stored = await storage.load(ws.id);
    expect(stored.data.metadata.title).toBe("A");
    expect(stored.revision).toBe(1);
    expect(autosave.pending).toBe(false);
    autosave.destroy();
  });

  it("restarts the quiet period on each change but never waits past ten seconds", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    const autosave = createAutosave(ws, storage, { persisted: true });
    expect(autosave.pending).toBe(false);
    for (let i = 0; i < 15; i += 1) {
      edit(ws, `T${i}`);
      await vi.advanceTimersByTimeAsync(900);
    }
    await settle();
    const stored = await storage.load(ws.id);
    expect(stored).toBeDefined();
    // Changes never went quiet, yet the ten-second ceiling forced a write that missed the last few.
    expect(stored.data.metadata.title).toBe("T11");
    expect(autosave.pending).toBe(true);
    autosave.destroy();
  });

  it("tracks the stored revision, so undoing back to it is clean", async () => {
    const ws = createWorkspace({ title: "A" });
    const autosave = createAutosave(ws, createMemoryStorage(), { persisted: true });
    edit(ws, "B");
    expect(autosave.pending).toBe(true);
    ws.undo();
    expect(autosave.pending).toBe(false);
    autosave.destroy();
  });

  it("flush writes now and reports the outcome", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    const autosave = createAutosave(ws, storage, { persisted: true });
    edit(ws, "B");
    expect(await autosave.flush()).toBe(true);
    expect((await storage.load(ws.id)).data.metadata.title).toBe("B");
    expect(autosave.status).toBe("saved");
    autosave.destroy();
  });

  it("keeps changes pending when a write fails, and succeeds on the next attempt", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    let fail = true;
    const save = storage.save;
    storage.save = async (record) => {
      if (fail) throw new Error("quota");
      return save(record);
    };
    const autosave = createAutosave(ws, storage, { persisted: true });
    const seen = [];
    autosave.subscribe(() => seen.push(autosave.status));
    edit(ws, "B");
    expect(await autosave.flush()).toBe(false);
    expect(autosave.status).toBe("failed");
    expect(autosave.error.message).toBe("quota");
    expect(autosave.pending).toBe(true);
    fail = false;
    expect(await autosave.flush()).toBe(true);
    expect(autosave.error).toBeNull();
    expect(seen).toContain("failed");
    autosave.destroy();
  });

  it("reports a newer stored revision as a conflict, then writes anyway", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    await storage.save({ id: ws.id, savedAt: 1, revision: 7, data: ws.serialized });
    const conflicts = [];
    const autosave = createAutosave(ws, storage, { persisted: true, revision: 3, onConflict: (r) => conflicts.push(r.revision) });
    edit(ws, "B");
    await autosave.flush();
    expect(conflicts).toEqual([7]);
    const stored = await storage.load(ws.id);
    expect(stored.revision).toBe(8);
    expect(stored.data.metadata.title).toBe("B");
    autosave.destroy();
  });

  it("does not write after it is destroyed", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    const autosave = createAutosave(ws, storage, { persisted: true });
    edit(ws, "B");
    autosave.destroy();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await storage.load(ws.id)).toBeUndefined();
  });
});

describe("page lifecycle", () => {
  it("flushes when the page is hidden and warns on unload only while something is pending", async () => {
    const ws = createWorkspace({ title: "A" });
    const storage = createMemoryStorage();
    const autosave = createAutosave(ws, storage, { persisted: true });
    const detach = attachPageLifecycle(autosave, { window, document });

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    edit(ws, "B");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    await settle();
    expect((await storage.load(ws.id)).data.metadata.title).toBe("B");

    edit(ws, "C");
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect((await storage.load(ws.id)).data.metadata.title).toBe("C");

    detach();
    edit(ws, "D");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    autosave.destroy();
  });
});
