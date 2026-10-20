import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createMemoryStorage } from "../src/persistence/storage.js";
import { restoreWorkspace, storagePointer } from "../src/persistence/restore.js";
import { createDemoWorkspace } from "../src/app/demo-seed.js";

const pointerTo = (id) => ({ get: () => id, set: () => undefined });

describe("restoreWorkspace", () => {
  it("brings back the workspace the pointer names", async () => {
    const ws = createDemoWorkspace({ title: "Mine" });
    const storage = createMemoryStorage();
    await storage.save({ id: ws.id, savedAt: 1, revision: 4, data: ws.serialized });
    const restored = await restoreWorkspace({ storage, pointer: pointerTo(ws.id) });
    expect(restored.failure).toBeNull();
    expect(restored.revision).toBe(4);
    expect(restored.workspace.title).toBe("Mine");
    expect(restored.workspace.getChildren(null)).toEqual(ws.getChildren(null));
    expect(restored.workspace.dirty).toBe(false);
  });

  it("returns nothing, without a failure, for a first visit or a missing record", async () => {
    const storage = createMemoryStorage();
    expect(await restoreWorkspace({ storage, pointer: pointerTo(null) })).toMatchObject({ workspace: null, failure: null });
    expect(await restoreWorkspace({ storage, pointer: pointerTo("gone") })).toMatchObject({ workspace: null, failure: null });
  });

  it("keeps a record that fails validation untouched and copies it under a recovery id", async () => {
    const ws = createWorkspace({ title: "Broken" });
    ws.dispatch("createPage", { type: "document", title: "D" });
    const data = ws.serialized;
    const pageId = Object.keys(data.pages)[0];
    data.pages[pageId].content = { blocks: "nope" };
    const storage = createMemoryStorage();
    await storage.save({ id: ws.id, savedAt: 1, revision: 2, data });
    const restored = await restoreWorkspace({ storage, pointer: pointerTo(ws.id), now: () => 5 });
    expect(restored.workspace).toBeNull();
    expect(restored.failure.error.message).toBeTruthy();
    expect((await storage.load(ws.id)).data).toEqual(data);
    expect((await storage.load(restored.failure.recoveryId)).data).toEqual(data);
    expect(restored.failure.recoveryId).toBe(`${ws.id}.recovery-5`);
  });

  it("reports a storage that throws", async () => {
    const storage = createMemoryStorage();
    storage.load = async () => {
      throw new Error("unreadable");
    };
    const restored = await restoreWorkspace({ storage, pointer: pointerTo("x") });
    expect(restored.workspace).toBeNull();
    expect(restored.failure.error.message).toBe("unreadable");
  });
});

describe("storagePointer", () => {
  it("reads and writes through the store, and survives one that throws", () => {
    const map = new Map();
    const pointer = storagePointer({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) });
    expect(pointer.get()).toBeNull();
    pointer.set("w1");
    expect(pointer.get()).toBe("w1");
    const blocked = storagePointer({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    });
    expect(blocked.get()).toBeNull();
    expect(() => blocked.set("w")).not.toThrow();
  });
});

describe("demo workspace", () => {
  it("has a document, a sheet and a deck, all valid, and starts clean", () => {
    const ws = createDemoWorkspace();
    const types = ws.getChildren(null).map((id) => ws.getPage(id).type);
    expect(types).toEqual(["document", "sheet", "presentation"]);
    expect(ws.dirty).toBe(false);
    const deck = ws.getPage(ws.getChildren(null)[2]).content;
    expect(deck.slideOrder).toHaveLength(2);
  });
});
