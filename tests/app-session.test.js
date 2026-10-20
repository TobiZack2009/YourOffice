import { describe, expect, it } from "vitest";
import { createSession } from "../src/app/session.js";

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("session", () => {
  it("starts from defaults and merges patches, reporting only real changes", () => {
    const session = createSession();
    expect(session.get().zoom).toBe(100);
    expect(session.set({ zoom: 120 })).toEqual(["zoom"]);
    expect(session.get().zoom).toBe(120);
    expect(session.set({ unknownKey: 1 })).toEqual([]);
  });

  it("notifies subscribers with the changed keys until they unsubscribe", () => {
    const session = createSession();
    const seen = [];
    const off = session.subscribe((_state, changed) => seen.push(changed));
    session.set({ sidebarVisible: false });
    off();
    session.set({ zoom: 90 });
    expect(seen).toEqual([["sidebarVisible"]]);
  });

  it("copies what it stores, so callers cannot mutate it behind its back", () => {
    const session = createSession();
    const tabs = { document: "insert" };
    session.set({ ribbonTabByType: tabs });
    tabs.document = "home";
    expect(session.get().ribbonTabByType.document).toBe("insert");
  });

  it("serialises everything but the volatile clipboard, and restores defensively", () => {
    const session = createSession();
    session.set({ zoom: 140, presentationClipboard: { objects: [{ id: "x" }], pastes: 1 } });
    const json = session.toJSON();
    expect(json.zoom).toBe(140);
    expect("presentationClipboard" in json).toBe(false);

    const other = createSession();
    other.restore({ ...json, zoom: "wide", sidebarVisible: "yes", sidebarCollapsed: ["a", 3], selectedPageId: 7 });
    expect(other.get().zoom).toBe(100);
    expect(other.get().sidebarVisible).toBe(true);
    expect(other.get().sidebarCollapsed).toEqual(["a"]);
    expect(other.get().selectedPageId).toBeNull();
    other.restore("garbage");
    expect(other.get().zoom).toBe(100);
  });

  it("persists to storage and loads from it, ignoring corrupt or failing storage", () => {
    const storage = memoryStorage();
    const first = createSession({}, { storage, key: "s" });
    first.set({ zoom: 150, presentationClipboard: { objects: [], pastes: 4 } });
    expect(JSON.parse(storage.data.s).zoom).toBe(150);
    expect(JSON.parse(storage.data.s).presentationClipboard).toBeUndefined();
    expect(createSession({}, { storage, key: "s" }).get().zoom).toBe(150);

    expect(createSession({}, { storage: memoryStorage({ s: "{nope" }), key: "s" }).get().zoom).toBe(100);
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    const session = createSession({}, { storage: broken, key: "s" });
    expect(() => session.set({ zoom: 80 })).not.toThrow();
    expect(session.get().zoom).toBe(80);
  });
});
