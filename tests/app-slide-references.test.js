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
    const { stripHandle, calls } = strip({ onHandle: (id, anchor) => calls.handle.push([id, anchor]) });
    const handle = stripHandle.element.querySelector("[data-role=slide-handle]");
    expect(handle.getAttribute("draggable")).toBe("false");
    click(handle);
    expect(calls.handle).toHaveLength(1);
    expect(calls.handle[0][0]).toBe("s1");
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
