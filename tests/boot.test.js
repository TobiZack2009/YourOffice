import { afterEach, describe, expect, it } from "vitest";
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
});
