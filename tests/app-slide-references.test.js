import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { registerPresentationCommands } from "../src/presentation/commands.js";
import { createPresentationEditor } from "../src/app/presentation-editor.js";
import { createSlideStrip } from "../src/app/slide-strip.js";
import { createPopoverHost } from "../src/app/popover.js";
import { clearNotice } from "../src/app/notice.js";

function setup(options = {}) {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  registerPresentationCommands(ws);
  ws.dispatch("createPage", { type: "presentation", title: "Deck" });
  ws.dispatch("createPage", { type: "document", title: "Notes" });
  const [pageId, docId] = ws.getChildren(null);
  ws.dispatch("createSlide", { pageId, layout: "blank", slideId: "s1" });
  ws.dispatch("createSlide", { pageId, layout: "blank", slideId: "s2" });
  const editor = createPresentationEditor(ws, pageId, options);
  document.body.append(editor.element);
  return { ws, pageId, docId, editor, sections: () => Object.values(ws.getPage(pageId).content.sections ?? {}) };
}

const handleOf = (editor, slideId) =>
  editor.element.querySelector(`.slide-thumb-wrap[data-slide-id="${slideId}"] [data-role=slide-handle]`);
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

afterEach(() => {
  clearNotice();
  document.body.replaceChildren();
});

describe("slide strip handle", () => {
  function strip(extra = {}) {
    const ws = Workspace.create({ title: "W" });
    registerPresentationCommands(ws);
    ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    const pageId = ws.getChildren(null)[0];
    ws.dispatch("createSlide", { pageId, layout: "blank", slideId: "s1" });
    const calls = { select: [], handle: [] };
    const popovers = createPopoverHost(document.body);
    const stripHandle = createSlideStrip({
      getContent: () => ws.getPage(pageId).content,
      getCurrent: () => "s1",
      popovers,
      onSelect: (id) => calls.select.push(id),
      onCreate: () => {},
      onDuplicate: () => {},
      onDelete: () => {},
      onMove: () => {},
      ...extra
    });
    document.body.append(stripHandle.element);
    return { stripHandle, calls };
  }

  it("has no handle unless the host asks for one", () => {
    const { stripHandle } = strip();
    expect(stripHandle.element.querySelector("[data-role=slide-handle]")).toBeNull();
  });

  it("reports a click on the handle without selecting or dragging the slide", () => {
    const { stripHandle, calls } = strip({ onHandle: (ids, anchor) => calls.handle.push([ids, anchor]) });
    const handle = stripHandle.element.querySelector("[data-role=slide-handle]");
    expect(handle.getAttribute("draggable")).toBe("false");
    click(handle);
    expect(calls.handle).toHaveLength(1);
    expect(calls.handle[0][0]).toEqual(["s1"]);
    expect(calls.handle[0][1]).toBe(handle);
    expect(calls.select).toEqual([]);
  });

  it("badges a slide with the number of places reading it", () => {
    const { stripHandle } = strip({ onHandle: () => {}, referenceCount: () => 3 });
    const handle = stripHandle.element.querySelector("[data-role=slide-handle]");
    expect(handle.classList.contains("has-references")).toBe(true);
    expect(handle.querySelector(".handle-badge").textContent).toBe("3");
  });
});

describe("presentation slide handle", () => {
  it("names a slide, creating a section for it", () => {
    const { ws, editor, sections } = setup();
    click(handleOf(editor, "s1"));
    click(document.querySelector("[data-action=section-make]"));
    document.querySelector(".name-prompt-input").value = "Agenda";
    document.querySelector("[data-action=name-confirm]").click();
    expect(sections()).toHaveLength(1);
    expect(sections()[0]).toMatchObject({ name: "Agenda", locator: { slideId: "s1" } });
    expect(ws.canUndo).toBe(true);
  });

  it("renames the implicit section a table embed already created", () => {
    const { ws, pageId, editor, sections } = setup();
    ws.dispatch("createSection", { pageId, locator: { slideId: "s2" }, implicit: true, sectionId: "sec_s2" });
    click(handleOf(editor, "s2"));
    click(document.querySelector("[data-action=section-make]"));
    document.querySelector(".name-prompt-input").value = "Closing";
    document.querySelector("[data-action=name-confirm]").click();
    expect(sections()).toHaveLength(1);
    expect(sections()[0]).toMatchObject({ id: "sec_s2", name: "Closing" });
    expect(sections()[0].implicit).toBeFalsy();
  });

  it("offers the section menu once the slide is named, with a live count", () => {
    const { ws, pageId, docId, editor } = setup();
    ws.dispatch("createSection", { pageId, locator: { slideId: "s1" }, name: "Agenda", sectionId: "sec_a" });
    ws.dispatch("insertReference", { pageId: docId, kind: "embed", sectionId: "sec_a", display: {} });
    editor.element.dispatchEvent(new Event("noop"));
    click(handleOf(editor, "s1"));
    expect(document.querySelector("[data-action=section-rename]")).not.toBeNull();
    expect(document.querySelector("[data-action=section-references]").textContent).toContain("(1)");
    expect(document.querySelector("[data-action=section-remove]")).not.toBeNull();
  });

  it("navigates to the page that reads the slide", () => {
    const navigate = vi.fn();
    const { ws, pageId, docId, editor } = setup({ navigate });
    ws.dispatch("createSection", { pageId, locator: { slideId: "s1" }, name: "Agenda", sectionId: "sec_a" });
    ws.dispatch("insertReference", { pageId: docId, kind: "embed", sectionId: "sec_a", display: {} });
    click(handleOf(editor, "s1"));
    click(document.querySelector("[data-action=section-references]"));
    click(document.querySelector(".reference-list-row"));
    expect(navigate).toHaveBeenCalledWith(docId);
  });

  it("shows the reference badge on the strip", () => {
    const { ws, pageId, docId, editor } = setup();
    ws.dispatch("createSection", { pageId, locator: { slideId: "s1" }, name: "Agenda", sectionId: "sec_a" });
    ws.dispatch("insertReference", { pageId: docId, kind: "embed", sectionId: "sec_a", display: {} });
    editor.refresh?.();
    expect(handleOf(editor, "s1").querySelector(".handle-badge")?.textContent).toBe("1");
    expect(handleOf(editor, "s2").querySelector(".handle-badge")).toBeNull();
  });
});

describe("slide strip selection", () => {
  function strip(extra = {}) {
    const ws = Workspace.create({ title: "W" });
    registerPresentationCommands(ws);
    ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    const pageId = ws.getChildren(null)[0];
    for (const slideId of ["s1", "s2", "s3", "s4"]) ws.dispatch("createSlide", { pageId, layout: "blank", slideId });
    const state = { current: "s1", handles: [], deleted: [] };
    let handle;
    const select = (id) => {
      state.current = id;
      handle.render();
    };
    handle = createSlideStrip({
      getContent: () => ws.getPage(pageId).content,
      getCurrent: () => state.current,
      popovers: createPopoverHost(document.body),
      onSelect: select,
      onCreate: () => {},
      onDuplicate: () => {},
      onDelete: (id) => state.deleted.push([id]),
      onDeleteMany: (ids) => state.deleted.push(ids),
      onMove: () => {},
      onHandle: (ids) => state.handles.push(ids),
      ...extra
    });
    document.body.append(handle.element);
    return { handle, state, ws, pageId };
  }
  const wrapOf = (handle, id) => handle.element.querySelector(`.slide-thumb-wrap[data-slide-id="${id}"]`);
  const press = (el, init = {}) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const marked = (handle) => [...handle.element.querySelectorAll(".is-selected")].map((el) => el.dataset.slideId);

  it("Shift+click selects the run from the current slide", () => {
    const { handle, state } = strip();
    press(wrapOf(handle, "s3"), { shiftKey: true });
    expect(state.current).toBe("s3");
    expect(handle.getSelection()).toEqual(["s1", "s2", "s3"]);
    expect(marked(handle)).toEqual(["s1", "s2", "s3"]);
  });

  it("Cmd/Ctrl+click toggles slides in any combination, reported in presentation order", () => {
    const { handle } = strip();
    press(wrapOf(handle, "s4"), { ctrlKey: true });
    press(wrapOf(handle, "s2"), { metaKey: true });
    expect(handle.getSelection()).toEqual(["s1", "s2", "s4"]);
    press(wrapOf(handle, "s2"), { ctrlKey: true });
    expect(handle.getSelection()).toEqual(["s1", "s4"]);
  });

  it("a plain click ends the selection", () => {
    const { handle, state } = strip();
    press(wrapOf(handle, "s3"), { shiftKey: true });
    press(wrapOf(handle, "s2"));
    expect(state.current).toBe("s2");
    expect(handle.getSelection()).toEqual(["s2"]);
    expect(marked(handle)).toEqual([]);
  });

  it("Shift+Arrow extends the selection and a plain arrow ends it", () => {
    const { handle } = strip();
    const key = (init) => handle.element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    key({ key: "ArrowDown", shiftKey: true });
    key({ key: "ArrowDown", shiftKey: true });
    expect(handle.getSelection()).toEqual(["s1", "s2", "s3"]);
    key({ key: "ArrowUp", shiftKey: true });
    expect(handle.getSelection()).toEqual(["s1", "s2"]);
    key({ key: "ArrowDown" });
    expect(handle.getSelection()).toEqual(["s3"]);
  });

  it("the handle of a selected slide reports the whole selection, others only themselves", () => {
    const { handle, state } = strip();
    press(wrapOf(handle, "s2"), { shiftKey: true });
    press(wrapOf(handle, "s2").querySelector("[data-role=slide-handle]"));
    press(wrapOf(handle, "s1").querySelector("[data-role=slide-handle]"));
    expect(state.handles).toEqual([["s1", "s2"], ["s1", "s2"]]);
    press(wrapOf(handle, "s2"));
    press(wrapOf(handle, "s4").querySelector("[data-role=slide-handle]"));
    expect(state.handles[2]).toEqual(["s4"]);
  });

  it("Delete removes the whole selection in one call", () => {
    const { handle, state } = strip();
    press(wrapOf(handle, "s2"), { shiftKey: true });
    handle.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    expect(state.deleted).toEqual([["s1", "s2"]]);
  });

  it("forgets slides that disappear", () => {
    const { handle, state, ws, pageId } = strip();
    press(wrapOf(handle, "s3"), { shiftKey: true });
    ws.dispatch("deleteSlide", { pageId, slideIds: ["s2", "s3"] });
    state.current = "s1";
    handle.render();
    expect(handle.getSelection()).toEqual(["s1"]);
    expect(marked(handle)).toEqual([]);
  });
});

describe("presentation multi-slide section", () => {
  function deck() {
    const t = setup();
    t.ws.dispatch("createSlide", { pageId: t.pageId, layout: "blank", slideId: "s3" });
    t.editor.refresh?.();
    return t;
  }
  const nameThem = (name) => {
    click(document.querySelector("[data-action=section-make]"));
    document.querySelector(".name-prompt-input").value = name;
    document.querySelector("[data-action=name-confirm]").click();
  };

  it("names a selection of slides as one section", () => {
    const { editor, sections } = deck();
    const wrap = (id) => editor.element.querySelector(`.slide-thumb-wrap[data-slide-id="${id}"]`);
    wrap("s2").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    click(handleOf(editor, "s2"));
    expect(document.querySelector("[data-action=section-make]").textContent).toContain("these");
    nameThem("Intro");
    expect(sections()).toHaveLength(1);
    expect(sections()[0]).toMatchObject({ name: "Intro" });
    expect(sections()[0].locator.slideIds).toEqual(["s1", "s2"]);
    expect(sections()[0].locator.slideId).toBe("s1");
  });

  it("reopens as a named section from any of its slides, and renames it", () => {
    const { ws, pageId, editor } = deck();
    ws.dispatch("createSection", { pageId, locator: { slideId: "s1", slideIds: ["s1", "s2"] }, name: "Intro", sectionId: "sec_i" });
    editor.element.querySelector(`.slide-thumb-wrap[data-slide-id="s2"]`).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    click(handleOf(editor, "s1"));
    expect(document.querySelector("[data-action=section-rename]")).not.toBeNull();
  });

  it("deleting a selection is one undoable change", () => {
    const { ws, pageId, editor } = deck();
    const order = () => ws.getPage(pageId).content.slideOrder;
    const before = order().length;
    editor.element.querySelector(`.slide-thumb-wrap[data-slide-id="s2"]`).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    editor.element.querySelector(".slide-strip").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    expect(order().length).toBe(before - 2);
    ws.undo();
    expect(order().length).toBe(before);
  });

  it("will not delete every slide", () => {
    const { ws, pageId, editor } = deck();
    const before = ws.getPage(pageId).content.slideOrder.length;
    editor.element.querySelector(".slide-strip").dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true }));
    editor.element.querySelector(".slide-strip").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    expect(ws.getPage(pageId).content.slideOrder.length).toBe(before);
  });
});
