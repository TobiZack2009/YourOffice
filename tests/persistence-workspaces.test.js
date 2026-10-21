import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/persistence/storage.js";
import { listWorkspaces, loadWorkspace } from "../src/persistence/workspaces.js";
import { createBlankWorkspace } from "../src/app/demo-seed.js";

async function store(storage, workspace, savedAt, id = workspace.id) {
  await storage.save({ id, savedAt, revision: 1, data: workspace.serialized });
}

describe("listWorkspaces", () => {
  it("lists real workspaces newest first, flags the active one, and puts recovery copies last", async () => {
    const storage = createMemoryStorage();
    const older = createBlankWorkspace("Older");
    const newer = createBlankWorkspace("Newer");
    await store(storage, older, 100);
    await store(storage, newer, 200);
    await store(storage, older, 900, `${older.id}.recovery-5`);

    const list = await listWorkspaces(storage, older.id);
    expect(list.map((entry) => entry.title)).toEqual(["Newer", "Older", "Older"]);
    expect(list.map((entry) => entry.recovery)).toEqual([false, false, true]);
    expect(list.find((entry) => entry.id === older.id)?.active).toBe(true);
    expect(list.filter((entry) => entry.active)).toHaveLength(1);
  });

  it("names a record without a usable title", async () => {
    const storage = createMemoryStorage();
    await storage.save({ id: "odd", savedAt: 1, revision: 1, data: { metadata: { title: "  " } } });
    expect((await listWorkspaces(storage, null))[0].title).toBe("Untitled workspace");
  });
});

describe("loadWorkspace", () => {
  it("returns the workspace and the stored revision", async () => {
    const storage = createMemoryStorage();
    const workspace = createBlankWorkspace("Kept");
    await storage.save({ id: workspace.id, savedAt: 1, revision: 7, data: workspace.serialized });
    const loaded = await loadWorkspace(storage, workspace.id);
    expect(loaded.workspace.title).toBe("Kept");
    expect(loaded.revision).toBe(7);
  });

  it("refuses a missing record", async () => {
    await expect(loadWorkspace(createMemoryStorage(), "nope")).rejects.toThrow("no longer stored");
  });

  it("refuses a record that fails the validation rules", async () => {
    const storage = createMemoryStorage();
    const workspace = createBlankWorkspace("Broken");
    const data = structuredClone(workspace.serialized);
    const pageId = Object.keys(data.pages)[0];
    data.pages[pageId].content = { blocks: "nope" };
    await storage.save({ id: workspace.id, savedAt: 1, revision: 1, data });
    await expect(loadWorkspace(storage, workspace.id)).rejects.toThrow();
  });
});
