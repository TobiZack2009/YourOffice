import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "../src/boot.js";
import { createMemoryStorage } from "../src/persistence/storage.js";
import { POINTER_KEY } from "../src/persistence/restore.js";

const durable = () => Object.assign(createMemoryStorage(), { durable: true });
const pointerStore = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), map };
};
const open = (storage, fallback = null) => async () => ({ storage, fallback });

let booted = null;
async function start(options) {
  const root = document.createElement("div");
  document.body.append(root);
  booted = await boot({ root, ...options });
  return { root, booted };
}

afterEach(() => {
  booted?.destroy();
  booted = null;
  document.body.innerHTML = "";
});

describe("boot", () => {
  it("opens the welcome workspace on a first visit and stores it", async () => {
    const storage = durable();
    const pointers = pointerStore();
    const { root, booted } = await start({ openStorage: open(storage), pointerStore: pointers });
    expect(root.querySelectorAll("[data-page-id]").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector(".app-notice")).toBeNull();
    expect(await booted.autosave().flush()).toBe(true);
    const id = booted.workspace().id;
    expect(pointers.map.get(POINTER_KEY)).toBe(id);
    expect((await storage.load(id)).data.metadata.id).toBe(id);
  });

  it("brings back what was saved on the next visit", async () => {
    const storage = durable();
    const pointers = pointerStore();
    const first = await start({ openStorage: open(storage), pointerStore: pointers });
    first.booted.workspace().dispatch("renameWorkspace", { title: "Carried over" });
    await first.booted.autosave().flush();
    first.booted.destroy();
    first.root.remove();

    const second = await start({ openStorage: open(storage), pointerStore: pointers });
    expect(second.booted.workspace().title).toBe("Carried over");
    expect(second.booted.workspace().dirty).toBe(false);
    expect(second.booted.autosave().pending).toBe(false);
  });

  it("keeps a corrupt record, tells the user and opens the welcome workspace", async () => {
    const storage = durable();
    const pointers = pointerStore();
    const first = await start({ openStorage: open(storage), pointerStore: pointers });
    const id = first.booted.workspace().id;
    await first.booted.autosave().flush();
    const record = await storage.load(id);
    const pageId = Object.keys(record.data.pages).find((p) => record.data.pages[p].type === "document");
    record.data.pages[pageId].content = { blocks: "nope" };
    await storage.save(record);
    first.booted.destroy();
    first.root.remove();

    const second = await start({ openStorage: open(storage), pointerStore: pointers });
    expect(second.booted.workspace().id).not.toBe(id);
    expect(document.querySelector(".app-notice")?.textContent).toContain("could not be opened");
    expect((await storage.load(id)).data.pages[pageId].content).toEqual({ blocks: "nope" });
    expect((await storage.list()).some((r) => r.id.startsWith(`${id}.recovery-`))).toBe(true);
  });

  it("without durable storage it says so, writes nothing and has no autosave", async () => {
    const storage = createMemoryStorage();
    const { root, booted } = await start({ openStorage: open(storage, new Error("blocked")), pointerStore: pointerStore() });
    expect(booted.autosave()).toBeNull();
    expect(document.querySelector(".app-notice")?.textContent).toContain("cannot keep your work");
    expect(await storage.list()).toEqual([]);
  });

  it("mounts a working shell: the first page opens in an editor", async () => {
    const { root } = await start({ openStorage: open(durable()), pointerStore: pointerStore() });
    expect(root.querySelector(".app")).toBeTruthy();
    expect(root.querySelector("[data-block-id]")).toBeTruthy();
  });

  describe("workspaces", () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    async function openSwitcher(root) {
      root.querySelector('.ribbon-tab[data-tab="file"]').click();
      root.querySelector('[data-action="workspaces"]').click();
      await settle();
      await settle();
    }
    const rows = () => [...document.querySelectorAll(".workspace-row")];

    it("offers the switcher only where workspaces are kept", async () => {
      const kept = await start({ openStorage: open(durable()), pointerStore: pointerStore() });
      kept.root.querySelector('.ribbon-tab[data-tab="file"]').click();
      expect(kept.root.querySelector('[data-action="workspaces"]').disabled).toBe(false);
      booted.destroy();
      kept.root.remove();

      const lost = await start({ openStorage: open(createMemoryStorage(), new Error("x")), pointerStore: pointerStore() });
      lost.root.querySelector('.ribbon-tab[data-tab="file"]').click();
      expect(lost.root.querySelector('[data-action="workspaces"]').disabled).toBe(true);
    });

    it("creates a blank workspace, keeps the old one stored and opens it again", async () => {
      const storage = durable();
      const { root, booted } = await start({ openStorage: open(storage), pointerStore: pointerStore() });
      const first = booted.workspace().id;
      await openSwitcher(root);
      expect(rows()).toHaveLength(1);

      document.querySelector('[data-role="new-workspace-name"]').value = "Scratch";
      document.querySelector('[data-action="create-workspace"]').click();
      await settle();
      await settle();
      expect(booted.workspace().id).not.toBe(first);
      expect(booted.workspace().title).toBe("Scratch");
      expect(booted.autosave()).not.toBeNull();
      await booted.autosave().flush();
      expect((await storage.list()).map((r) => r.id).sort()).toEqual([first, booted.workspace().id].sort());
      expect(booted.workspace().dirty).toBe(false);

      await openSwitcher(root);
      expect(rows()).toHaveLength(2);
      document.querySelector(`[data-action="open-workspace"][data-workspace-id="${first}"]`).click();
      await settle();
      await settle();
      expect(booted.workspace().id).toBe(first);
      expect(root.querySelector("[data-page-id]")).toBeTruthy();
    });

    it("deletes a stored workspace after asking, never the open one", async () => {
      const storage = durable();
      const { root, booted } = await start({ openStorage: open(storage), pointerStore: pointerStore() });
      const first = booted.workspace().id;
      await openSwitcher(root);
      document.querySelector('[data-action="create-workspace"]').click();
      await settle();
      await settle();
      await booted.autosave().flush();

      await openSwitcher(root);
      const ask = vi.spyOn(window, "confirm");
      const target = () => document.querySelector(`.workspace-row:has([data-workspace-id="${first}"]) [data-action="delete-workspace"]`);
      const active = document.querySelector(".workspace-row:has(.workspace-meta:not(:empty)) [data-action='delete-workspace'][disabled]");
      expect(active).toBeTruthy();

      ask.mockReturnValue(false);
      target().click();
      await settle();
      expect(await storage.load(first)).toBeTruthy();

      ask.mockReturnValue(true);
      target().click();
      await settle();
      await settle();
      expect(await storage.load(first)).toBeUndefined();
      expect(rows()).toHaveLength(1);
      ask.mockRestore();
    });

    it("stays where it is when the open workspace cannot be stored first", async () => {
      const storage = durable();
      const { root, booted } = await start({ openStorage: open(storage), pointerStore: pointerStore() });
      const first = booted.workspace().id;
      booted.workspace().dispatch("renameWorkspace", { title: "Unsaved" });
      storage.save = async () => {
        throw new Error("disk full");
      };
      await openSwitcher(root);
      document.querySelector('[data-action="create-workspace"]').click();
      await settle();
      await settle();
      expect(booted.workspace().id).toBe(first);
      expect(document.querySelector(".app-notice")?.textContent).toContain("could not be saved");
    });
  });
});
