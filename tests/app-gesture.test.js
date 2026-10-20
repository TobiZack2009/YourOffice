import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createObject } from "../src/presentation/model.js";
import { createDocumentEditor } from "../src/app/block-editor.js";
import { createSheetEditor } from "../src/app/sheet-editor.js";
import { createPresentationEditor } from "../src/app/presentation-editor.js";

const MOUSE_TYPES = new Set(["mousemove", "mouseup", "mousedown", "pointermove", "pointerup"]);

/**
 * Net document-level mouse listeners. Started before an editor is built, it reads zero once the
 * editor is destroyed only if every listener the editor (or a gesture) added was taken back.
 */
function trackDocumentListeners() {
  const bag = new Map();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const key = (type, opts) => `${type}:${opts === true || opts?.capture === true ? "c" : "b"}`;
  vi.spyOn(document, "addEventListener").mockImplementation(function (type, fn, opts) {
    if (MOUSE_TYPES.has(type)) {
      const set = bag.get(key(type, opts)) ?? new Set();
      set.add(fn);
      bag.set(key(type, opts), set);
    }
    return add.call(this, type, fn, opts);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation(function (type, fn, opts) {
    bag.get(key(type, opts))?.delete(fn);
    return remove.call(this, type, fn, opts);
  });
  return { count: () => [...bag.values()].reduce((sum, set) => sum + set.size, 0) };
}

const mouse = (type, target, x = 0, y = 0, init = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, ...init }));

/** Count change events that carry a command. */
function watchCommits(ws) {
  let commits = 0;
  ws.events.on("change", (change) => {
    if (change.kind === "commit") commits++;
  });
  return () => commits;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("document block drag", () => {
  function setup() {
    const ws = createWorkspace({ title: "Doc" });
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    const pageId = ws.getChildren(null)[0];
    for (const text of ["one", "two", "three"]) {
      ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text }] } });
    }
    const editor = createDocumentEditor(ws, pageId);
    document.body.append(editor.element);
    const order = () => ws.getPage(pageId).content.blockOrder;
    return { ws, pageId, editor, order };
  }

  it("a destroyed editor ignores the rest of a block drag and leaves no listeners", () => {
    const tracker = trackDocumentListeners();
    const { ws, editor, order } = setup();
    const before = order();
    const commits = watchCommits(ws);
    const first = editor.element.querySelector(`[data-block-id="${before[0]}"]`);
    first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const handle = editor.element.querySelector("[data-role=block-handle]");
    const baseline = tracker.count();
    mouse("mousedown", handle, 0, 0);
    expect(tracker.count()).toBeGreaterThan(baseline);
    mouse("mousemove", document, 0, 50);
    editor.destroy();
    expect(tracker.count()).toBe(0);
    mouse("mousemove", document, 0, 200);
    mouse("mouseup", document, 0, 200);
    expect(commits()).toBe(0);
    expect(order()).toEqual(before);
  });
});

describe("sheet gestures", () => {
  function setup() {
    const ws = createWorkspace({ title: "W" });
    ws.dispatch("createPage", { type: "sheet", title: "S" });
    const pageId = ws.getChildren(null)[0];
    const { tableId } = ws.dispatch("createTable", { pageId, name: "T", rows: 4, columns: 3, x: 0, y: 0 });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    const editor = createSheetEditor(ws, pageId);
    document.body.append(editor.element);
    return { ws, pageId, tableId, editor };
  }

  it("a destroyed editor ignores the rest of a fill drag", () => {
    const tracker = trackDocumentListeners();
    const { ws, tableId, editor } = setup();
    const commits = watchCommits(ws);
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 0, row: 0 });
    editor.element.querySelector("[data-role=fill-handle]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    editor.element.querySelector('[data-key="0,2"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    editor.destroy();
    expect(tracker.count()).toBe(0);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(commits()).toBe(0);
  });

  it("a destroyed editor ignores the rest of a column resize", () => {
    const { ws, editor } = setup();
    const commits = watchCommits(ws);
    const handle = editor.element.querySelector(".sheet-resize-handle");
    expect(handle).toBeTruthy();
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 160 }));
    editor.destroy();
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 220 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 220 }));
    expect(commits()).toBe(0);
  });
});

describe("presentation gestures", () => {
  function setup() {
    const ws = createWorkspace({ title: "W" });
    ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    const pageId = ws.getChildren(null)[0];
    const { slideId } = ws.dispatch("createSlide", { pageId, layout: "blank" });
    const object = createObject("shape", { x: 100, y: 100, width: 200, height: 100 });
    ws.dispatch("insertObject", { pageId, slideId, object });
    const editor = createPresentationEditor(ws, pageId, { view: { inspector: true, snap: false, grid: false } });
    document.body.append(editor.element);
    return { ws, editor, id: object.id };
  }

  for (const [name, handleSelector, from, to] of [
    ["move", null, [150, 120], [250, 220]],
    ["resize", '[data-handle="se"]', [300, 200], [380, 260]],
    ["rotate", '[data-handle="rotate"]', [200, 50], [300, 150]]
  ]) {
    it(`a destroyed editor ignores the rest of a ${name} gesture`, () => {
      const tracker = trackDocumentListeners();
      const { ws, editor, id } = setup();
      editor.selectObjects([id]);
      const commits = watchCommits(ws);
      const target = handleSelector
        ? editor.element.querySelector(`.selection-box[data-object-id="${id}"] ${handleSelector}`)
        : editor.element.querySelector(`[data-object-id="${id}"]`);
      mouse("mousedown", target, from[0], from[1]);
      mouse("mousemove", document, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
      editor.destroy();
      expect(tracker.count()).toBe(0);
      mouse("mousemove", document, to[0], to[1]);
      mouse("mouseup", document, to[0], to[1]);
      expect(commits()).toBe(0);
      });
  }
});

describe("createGestureScope", async () => {
  const { createGestureScope } = await import("../src/app/gesture.js");

  it("removes what it registered and runs cancel hooks on abort, and stays usable", () => {
    const scope = createGestureScope(document);
    const seen = [];
    const cancel = vi.fn();
    scope.onAbort(cancel);
    const stop = scope.listen("mousemove", () => seen.push("a"));
    scope.listen("mouseup", () => seen.push("b"));
    expect(scope.size()).toBe(2);
    stop();
    expect(scope.size()).toBe(1);
    document.dispatchEvent(new MouseEvent("mousemove"));
    expect(seen).toEqual([]);
    scope.abort();
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(seen).toEqual([]);
    expect(scope.size()).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    scope.listen("mouseup", () => seen.push("c"));
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(seen).toEqual(["c"]);
    scope.abort();
  });
});
