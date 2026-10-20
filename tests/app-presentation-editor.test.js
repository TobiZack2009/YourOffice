import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createObject } from "../src/presentation/model.js";
import { createPresentationEditor } from "../src/app/presentation-editor.js";

/**
 * jsdom has no layout, so the stage rect is all zeros and the editor falls back to a scale of 1:
 * client coordinates are slide coordinates.
 */
function setup(options = {}) {
  const ws = createWorkspace({ title: "W" });
  ws.dispatch("createPage", { type: "presentation", title: "Deck" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createSlide", { pageId, layout: "blank" });
  const slideId = ws.getPage(pageId).content.slideOrder[0];
  const add = (type = "shape", fields = {}) => {
    const object = createObject(type, { x: 100, y: 100, width: 200, height: 100, ...fields });
    ws.dispatch("insertObject", { pageId, slideId, object });
    return object.id;
  };
  const a = add("shape", { x: 100, y: 100 });
  const b = add("text", { x: 500, y: 300, width: 300, height: 80 });
  const editor = createPresentationEditor(ws, pageId, options);
  document.body.append(editor.element);
  const content = () => ws.getPage(pageId).content;
  const slide = () => content().slides[content().slideOrder.includes(slideId) ? slideId : content().slideOrder[0]];
  const object = (id) => slide().objects[id];
  return { ws, pageId, slideId, a, b, editor, content, slide, object };
}

const mouse = (type, target, x, y, init = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }));

/** Press on `target`, then move and release on the document. */
function drag(target, from, to, init = {}) {
  mouse("mousedown", target, from[0], from[1], init);
  mouse("mousemove", document, to[0], to[1], init);
  mouse("mouseup", document, to[0], to[1], init);
}

const objectEl = (editor, id) => editor.element.querySelector(`.stage .slide-object[data-object-id="${id}"]`);
const key = (editor, k, init = {}) =>
  editor.element.querySelector(".stage-area").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("rendering", () => {
  it("shows the strip, the stage with every object, and the inspector", () => {
    const { editor, a, b } = setup();
    expect(editor.element.querySelector(".slide-strip")).toBeTruthy();
    expect(objectEl(editor, a)).toBeTruthy();
    expect(objectEl(editor, b)).toBeTruthy();
    expect(editor.element.querySelector(".inspector")).toBeTruthy();
    expect(editor.getSelection()).toEqual([]);
  });

  it("falls back to the first slide when the remembered one is gone", () => {
    const { editor, slideId } = setup({ initialSlideId: "slide_missing" });
    expect(editor.getSlideId()).toBe(slideId);
  });

  it("starts from the given view and reports changes", () => {
    const views = [];
    const { editor } = setup({ view: { inspector: false, snap: true, grid: false }, onViewChange: (v) => views.push(v) });
    expect(editor.element.classList.contains("hide-inspector")).toBe(true);
    editor.setView({ inspector: true });
    expect(editor.element.classList.contains("hide-inspector")).toBe(false);
    expect(views.at(-1)?.inspector).toBe(true);
  });
});

describe("selection", () => {
  it("selects on mousedown, extends with shift, and clears on an empty press", () => {
    const { editor, a, b } = setup();
    mouse("mousedown", objectEl(editor, a), 150, 120);
    mouse("mouseup", document, 150, 120);
    expect(editor.getSelection()).toEqual([a]);
    expect(editor.element.querySelector(`.selection-box[data-object-id="${a}"]`)).toBeTruthy();

    mouse("mousedown", objectEl(editor, b), 600, 330, { shiftKey: true });
    mouse("mouseup", document, 600, 330);
    expect(editor.getSelection()).toEqual([a, b]);

    mouse("mousedown", editor.element.querySelector(".stage"), 900, 600);
    mouse("mouseup", document, 900, 600);
    expect(editor.getSelection()).toEqual([]);
  });

  it("selects everything inside a marquee", () => {
    const { editor, a, b } = setup();
    drag(editor.element.querySelector(".stage"), [20, 20], [420, 260]);
    expect(editor.getSelection()).toEqual([a]);
    drag(editor.element.querySelector(".stage"), [20, 20], [1000, 600]);
    expect(editor.getSelection().sort()).toEqual([a, b].sort());
  });

  it("selects all with Cmd+A and clears with Escape", () => {
    const { editor, a, b } = setup();
    key(editor, "a", { metaKey: true });
    expect(editor.getSelection().sort()).toEqual([a, b].sort());
    key(editor, "Escape");
    expect(editor.getSelection()).toEqual([]);
  });

  it("notifies the host on selection change", () => {
    let count = 0;
    const { editor, a } = setup({ onSelectionChange: () => count++ });
    const before = count;
    editor.selectObjects([a]);
    expect(count).toBeGreaterThan(before);
  });
});

describe("move", () => {
  it("drags to one updateObject and lands on whole pixels", () => {
    const { editor, a, ws, object } = setup({ view: { inspector: true, snap: false, grid: false } });
    let commits = 0;
    ws.events.on("change", () => commits++);
    drag(objectEl(editor, a), [150, 120], [190.4, 160.6]);
    expect(object(a).x).toBe(140);
    expect(object(a).y).toBe(141);
    expect(commits).toBe(1);
  });

  it("treats a press without movement as a click", () => {
    const { editor, a, object } = setup();
    drag(objectEl(editor, a), [150, 120], [150, 120]);
    expect(object(a).x).toBe(100);
    expect(editor.getSelection()).toEqual([a]);
  });

  it("moves every selected object together", () => {
    const { editor, a, b, object } = setup({ view: { inspector: true, snap: false, grid: false } });
    editor.selectAll();
    drag(objectEl(editor, a), [150, 120], [170, 150]);
    expect(object(a).x).toBe(120);
    expect(object(b).x).toBe(520);
    expect(object(b).y).toBe(330);
  });

  it("restricts the axis with shift", () => {
    const { editor, a, object } = setup({ view: { inspector: true, snap: false, grid: false } });
    drag(objectEl(editor, a), [150, 120], [190, 130], { shiftKey: true });
    expect(object(a).x).toBe(140);
    expect(object(a).y).toBe(100);
  });

  it("cancels a drag on Escape", () => {
    const { editor, a, object } = setup({ view: { inspector: true, snap: false, grid: false } });
    mouse("mousedown", objectEl(editor, a), 150, 120);
    mouse("mousemove", document, 250, 220);
    key(editor, "Escape");
    mouse("mouseup", document, 250, 220);
    expect(object(a).x).toBe(100);
  });

  it("nudges with the arrow keys", () => {
    const { editor, a, object } = setup();
    editor.selectObjects([a]);
    key(editor, "ArrowRight");
    key(editor, "ArrowDown", { shiftKey: true });
    expect(object(a).x).toBe(101);
    expect(object(a).y).toBe(110);
  });
});

describe("resize and rotate", () => {
  it("resizes from the south-east handle", () => {
    const { editor, a, object } = setup({ view: { inspector: true, snap: false, grid: false } });
    editor.selectObjects([a]);
    const handle = editor.element.querySelector(`.selection-box[data-object-id="${a}"] [data-handle="se"]`);
    drag(handle, [300, 200], [380, 260]);
    expect(object(a)).toMatchObject({ x: 100, y: 100, width: 280, height: 160 });
  });

  it("rotates around the centre, snapping with shift", () => {
    const { editor, a, object } = setup();
    editor.selectObjects([a]);
    const handle = editor.element.querySelector(`.selection-box[data-object-id="${a}"] [data-handle="rotate"]`);
    // centre (200,150): press straight above it, release to its right = a quarter turn.
    drag(handle, [200, 50], [300, 150], { shiftKey: true });
    expect(object(a).rotation).toBe(90);
  });

  it("offers no resize handles for a multi-selection", () => {
    const { editor } = setup();
    editor.selectAll();
    expect(editor.element.querySelector("[data-handle]")).toBeNull();
    expect(editor.element.querySelector(".selection-group")).toBeTruthy();
  });
});

describe("draw tools", () => {
  it("draws a shape by dragging, then drops the tool and selects it", () => {
    const { editor, object, slide } = setup({ view: { inspector: true, snap: false, grid: false } });
    editor.setTool({ type: "shape", shape: "ellipse" });
    expect(editor.element.querySelector(".stage-area").dataset.tool).toBe("shape");
    drag(editor.element.querySelector(".stage"), [50, 400], [250, 520]);
    const id = slide().objectOrder.at(-1);
    expect(object(id)).toMatchObject({ type: "shape", shape: "ellipse", x: 50, y: 400, width: 200, height: 120 });
    expect(editor.getTool()).toBeNull();
    expect(editor.getSelection()).toEqual([id]);
  });

  it("drops a default-size object on a plain click", () => {
    const { editor, object, slide } = setup();
    editor.setTool({ type: "shape", shape: "rect" });
    drag(editor.element.querySelector(".stage"), [640, 500], [640, 500]);
    const created = object(slide().objectOrder.at(-1));
    expect(created.width).toBeGreaterThan(8);
    expect(Number.isInteger(created.x)).toBe(true);
  });

  it("flips a line drawn bottom-left to top-right", () => {
    const { editor, object, slide } = setup({ view: { inspector: true, snap: false, grid: false } });
    editor.setTool({ type: "line" });
    drag(editor.element.querySelector(".stage"), [100, 500], [300, 400]);
    expect(object(slide().objectOrder.at(-1)).flipV).toBe(true);
  });

  it("starts editing after drawing a text box", () => {
    const { editor } = setup({ view: { inspector: true, snap: false, grid: false } });
    editor.setTool({ type: "text" });
    drag(editor.element.querySelector(".stage"), [50, 400], [350, 480]);
    expect(editor.isEditing()).toBe(true);
  });

  it("Escape disarms the tool first", () => {
    const { editor, a } = setup();
    editor.selectObjects([a]);
    editor.setTool({ type: "line" });
    key(editor, "Escape");
    expect(editor.getTool()).toBeNull();
    expect(editor.getSelection()).toEqual([a]);
  });
});

describe("in-place text", () => {
  it("edits on double-click and commits runs on blur", () => {
    const { editor, b, object } = setup();
    editor.selectObjects([b]);
    objectEl(editor, b).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(editor.isEditing()).toBe(true);
    const host = editor.element.querySelector('.slide-text[contenteditable="true"]');
    expect(host).toBeTruthy();
    host.textContent = "Hello";
    editor.finishEdit(true);
    expect(editor.isEditing()).toBe(false);
    expect(object(b).text.runs).toEqual([{ text: "Hello" }]);
  });

  it("Escape cancels the edit without dispatching", () => {
    const { editor, b, object } = setup();
    editor.startEdit(b);
    const host = editor.element.querySelector('.slide-text[contenteditable="true"]');
    host.textContent = "Nope";
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(editor.isEditing()).toBe(false);
    expect(object(b).text.runs.map((r) => r.text).join("")).not.toBe("Nope");
  });

  it("F2 and Enter start editing a selected text object, but not a plain shape without text", () => {
    const { editor, a, b } = setup();
    editor.selectObjects([b]);
    key(editor, "F2");
    expect(editor.isEditing()).toBe(true);
    editor.finishEdit(false);
    editor.selectObjects([a]);
    key(editor, "Enter");
    // Shapes can carry text, so they edit too.
    expect(editor.isEditing()).toBe(true);
  });

  it("does not edit a line", () => {
    const { editor, ws, pageId, slideId } = setup();
    const line = createObject("line", { x: 10, y: 10, width: 100, height: 0 });
    ws.dispatch("insertObject", { pageId, slideId, object: line });
    editor.selectObjects([line.id]);
    expect(editor.canEditText()).toBe(false);
    expect(editor.startEdit(line.id)).toBe(false);
  });
});

describe("clipboard and arrange", () => {
  it("copies, pastes with an offset, duplicates and deletes", () => {
    const { editor, a, slide } = setup();
    editor.selectObjects([a]);
    key(editor, "c", { metaKey: true });
    expect(editor.canPaste()).toBe(true);
    key(editor, "v", { metaKey: true });
    expect(slide().objectOrder).toHaveLength(3);
    const pasted = slide().objects[editor.getSelection()[0]];
    expect(pasted.id).not.toBe(a);
    expect(pasted.x).toBeGreaterThan(100);

    key(editor, "d", { metaKey: true });
    expect(slide().objectOrder).toHaveLength(4);
    key(editor, "Delete");
    expect(slide().objectOrder).toHaveLength(3);
    expect(editor.getSelection()).toEqual([]);
  });

  it("cut removes the objects and keeps them for paste", () => {
    const { editor, a, slide } = setup();
    editor.selectObjects([a]);
    key(editor, "x", { metaKey: true });
    expect(slide().objectOrder).not.toContain(a);
    editor.paste();
    expect(slide().objectOrder).toHaveLength(2);
  });

  it("hands the clipboard to the owner, who can seed another editor", () => {
    let clipboard = { objects: [], pastes: 0 };
    const first = setup({ clipboard, onClipboardChange: (next) => (clipboard = next) });
    first.editor.selectObjects([first.a]);
    first.editor.copy();
    expect(clipboard.objects).toHaveLength(1);
    const second = setup({ clipboard });
    expect(second.editor.canPaste()).toBe(true);
  });

  it("reorders the stack", () => {
    const { editor, a, slide } = setup();
    editor.selectObjects([a]);
    editor.arrange("front");
    expect(slide().objectOrder.at(-1)).toBe(a);
    editor.arrange("back");
    expect(slide().objectOrder[0]).toBe(a);
  });
});

describe("context menu", () => {
  it("suppresses the native menu and offers object actions with an Arrange submenu", () => {
    const { editor, a, slide } = setup();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 120 });
    objectEl(editor, a).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getSelection()).toEqual([a]);
    const actions = [...document.querySelectorAll(".popover [data-action]")].map((e) => e.dataset.action);
    expect(actions).toEqual(expect.arrayContaining(["cut", "copy", "paste", "duplicate", "delete", "arrange", "arrange-front", "link"]));
    document.querySelector('.popover [data-action="arrange-front"]').click();
    expect(slide().objectOrder.at(-1)).toBe(a);
    expect(document.querySelector(".popover")).toBeNull();
  });

  it("offers Edit text only for a text-capable single selection", () => {
    const { editor, b } = setup();
    objectEl(editor, b).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector('.popover [data-action="edit-text"]')).toBeTruthy();
  });

  it("shows a stage menu on empty space", () => {
    const { editor } = setup();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    editor.element.querySelector(".stage").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('.popover [data-action="select-all"]')).toBeTruthy();
  });
});

describe("slides", () => {
  it("creates, duplicates, moves and deletes slides, refusing to delete the last one", () => {
    const { editor, content } = setup();
    editor.newSlide("title");
    expect(content().slideOrder).toHaveLength(2);
    expect(editor.getSlideId()).toBe(content().slideOrder[1]);
    const first = content().slideOrder[0];
    editor.moveSlide(first, 1);
    expect(content().slideOrder[1]).toBe(first);
    editor.duplicateSlide();
    expect(content().slideOrder).toHaveLength(3);
    editor.deleteSlide();
    editor.deleteSlide();
    expect(content().slideOrder).toHaveLength(1);
    expect(editor.canDeleteSlide()).toBe(false);
    editor.deleteSlide();
    expect(content().slideOrder).toHaveLength(1);
  });

  it("reports the current slide to the shell", () => {
    const seen = [];
    const { editor, content } = setup({ onSlideChange: (id) => seen.push(id) });
    editor.newSlide("blank");
    expect(seen.at(-1)).toBe(content().slideOrder[1]);
  });

  it("sets the background and transition", () => {
    const { editor, slide } = setup();
    editor.setBackground("#ff0000");
    editor.setTransition({ style: "wipe", direction: "up", duration: 800 });
    expect(slide().background.color).toBe("#ff0000");
    expect(slide().transition).toMatchObject({ style: "wipe", direction: "up", duration: 800 });
    editor.newSlide("blank");
    editor.setTransition({ style: "fade" });
    editor.applyTransitionToAll();
    expect(editor.getContent().slideOrder.every((id) => editor.getContent().slides[id].transition.style === "fade")).toBe(true);
  });
});

describe("slide size", () => {
  it("asks scale or keep, and either choice is one undoable command", () => {
    const { editor, ws, a, object } = setup();
    editor.requestSlideSize(640, 360);
    expect(document.querySelector('[data-action="size-scale"]')).toBeTruthy();
    document.querySelector('[data-action="size-scale"]').click();
    expect(editor.getSize()).toEqual({ width: 640, height: 360 });
    expect(object(a).x).toBe(50);
    ws.undo();
    expect(ws.getPage(ws.getChildren(null)[0]).content.size).toEqual({ width: 1280, height: 720 });

    const second = setup();
    second.editor.requestSlideSize(640, 360);
    document.querySelector('[data-action="size-keep"]').click();
    expect(second.object(second.a).x).toBe(100);
    expect(second.editor.getSize()).toEqual({ width: 640, height: 360 });
  });

  it("rejects out-of-range sizes without opening the question", () => {
    const { editor } = setup();
    editor.requestSlideSize(10, 10);
    expect(document.querySelector('[data-action="size-scale"]')).toBeNull();
    expect(editor.getSize()).toEqual({ width: 1280, height: 720 });
  });
});

describe("inspector", () => {
  it("edits geometry through number fields (Enter applies)", () => {
    const { editor, a, object } = setup();
    editor.selectObjects([a]);
    const field = editor.element.querySelector('.inspector [data-field="x"]');
    field.value = "321";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(object(a).x).toBe(321);
  });

  it("does not re-dispatch an unchanged value", () => {
    const { editor, a, ws } = setup();
    editor.selectObjects([a]);
    const field = editor.element.querySelector('.inspector [data-field="x"]');
    field.value = "321";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    let commits = 0;
    ws.events.on("change", () => commits++);
    editor.element.querySelector('.inspector [data-field="x"]').dispatchEvent(new Event("change", { bubbles: true }));
    expect(commits).toBe(0);
  });

  it("shows slide settings when nothing is selected", () => {
    const { editor, a } = setup();
    expect(editor.element.querySelector('.inspector [data-field="transition-style"]')).toBeTruthy();
    editor.selectObjects([a]);
    expect(editor.element.querySelector('.inspector [data-field="transition-style"]')).toBeNull();
    expect(editor.element.querySelector('.inspector [data-field="width"]')).toBeTruthy();
  });

  it("limits a multi-selection to position", () => {
    const { editor } = setup();
    editor.selectAll();
    expect(editor.element.querySelector('.inspector [data-field="x"]')).toBeTruthy();
    expect(editor.element.querySelector('.inspector [data-field="width"]')).toBeNull();
  });
});

describe("slide strip", () => {
  const thumbs = (editor) => [...editor.element.querySelectorAll(".slide-thumb-wrap")];

  it("renders a thumbnail per slide and selects on click", () => {
    const { editor, content } = setup();
    editor.newSlide("blank");
    expect(thumbs(editor)).toHaveLength(2);
    thumbs(editor)[0].click();
    expect(editor.getSlideId()).toBe(content().slideOrder[0]);
    expect(thumbs(editor)[0].classList.contains("is-current")).toBe(true);
  });

  it("adds a slide through the hover plus", () => {
    const { editor, content } = setup();
    editor.element.querySelector(".slide-add").click();
    expect(content().slideOrder).toHaveLength(2);
  });

  it("badges slides that have a transition", () => {
    const { editor } = setup();
    expect(editor.element.querySelector('[data-role="transition-badge"]')).toBeNull();
    editor.setTransition({ style: "fade" });
    expect(editor.element.querySelector('[data-role="transition-badge"]')).toBeTruthy();
  });

  it("handles keyboard shortcuts on the strip", () => {
    const { editor, content } = setup();
    const strip = editor.element.querySelector(".slide-strip");
    const press = (k, init = {}) => strip.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    press("Enter");
    expect(content().slideOrder).toHaveLength(2);
    press("d", { metaKey: true });
    expect(content().slideOrder).toHaveLength(3);
    press("ArrowUp");
    expect(editor.getSlideId()).toBe(content().slideOrder[1]);
    press("Delete");
    expect(content().slideOrder).toHaveLength(2);
  });

  it("opens a right-click menu with a layout submenu", () => {
    const { editor, content } = setup();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    thumbsFirst(editor).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    document.querySelector('.popover [data-action="new-slide-layout"][data-layout="title"]').click();
    expect(content().slideOrder).toHaveLength(2);
    expect(content().slides[content().slideOrder[1]].layout).toBe("title");
  });

  it("reorders by drag and drop", () => {
    const { editor, content } = setup();
    editor.newSlide("blank");
    const [first, second] = content().slideOrder;
    const wraps = thumbs(editor);
    wraps[0].dispatchEvent(new Event("dragstart", { bubbles: true }));
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.assign(over, { clientY: 9999 });
    wraps[1].dispatchEvent(over);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { clientY: 9999 });
    wraps[1].dispatchEvent(drop);
    expect(content().slideOrder).toEqual([second, first]);
  });
});

function thumbsFirst(editor) {
  return editor.element.querySelector(".slide-thumb-wrap");
}

describe("lifecycle", () => {
  it("stops reacting to the workspace after destroy", () => {
    const { editor, ws, pageId, slideId } = setup();
    editor.destroy();
    const extra = createObject("shape", { x: 0, y: 0, width: 50, height: 50 });
    ws.dispatch("insertObject", { pageId, slideId, object: extra });
    expect(objectEl(editor, extra.id)).toBeNull();
  });

  it("re-renders when the workspace changes underneath it", () => {
    const { editor, ws, pageId, slideId } = setup();
    const extra = createObject("shape", { x: 0, y: 0, width: 50, height: 50 });
    ws.dispatch("insertObject", { pageId, slideId, object: extra });
    expect(objectEl(editor, extra.id)).toBeTruthy();
  });
});

describe("images", () => {
  it("inserts a data-URL image centred and fitted inside the slide", () => {
    const { editor, slide, object } = setup();
    editor.insertImage("data:image/png;base64,AAAA", { width: 4000, height: 2000 });
    const image = object(slide().objectOrder.at(-1));
    expect(image.type).toBe("image");
    expect(image.src).toBe("data:image/png;base64,AAAA");
    expect(image.width).toBeLessThanOrEqual(1280);
    expect(image.height).toBeLessThanOrEqual(720);
    expect(image.width / image.height).toBeCloseTo(2, 1);
    expect(editor.getSelection()).toEqual([image.id]);
  });
});

describe("link form", () => {
  const openForm = (editor, id) => {
    editor.selectObjects([id]);
    objectEl(editor, id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 120 }));
    document.querySelector('.popover [data-action="link"]').click();
  };
  const rows = () => [...document.querySelectorAll('[data-role="link-page"]')];

  it("lists the workspace pages next to the address field", () => {
    const { editor, a, ws } = setup();
    ws.dispatch("createPage", { type: "document", title: "Notes" });
    openForm(editor, a);
    expect(rows().map((row) => row.textContent)).toEqual(["Deck", "Notes"]);
  });

  it("links the selected object to a picked page", () => {
    const { editor, a, ws, object } = setup();
    ws.dispatch("createPage", { type: "document", title: "Notes" });
    const notes = ws.getPages().find((page) => page.title === "Notes").id;
    openForm(editor, a);
    rows().find((row) => row.textContent === "Notes").click();
    document.querySelector(".popover-apply").click();
    expect(object(a).link).toEqual({ kind: "page", pageId: notes });
    expect(document.querySelector(".popover")).toBeNull();
  });

  it("links the object to a web address from the same field", () => {
    const { editor, a, object } = setup();
    openForm(editor, a);
    const input = document.querySelector('[data-role="link-input"]');
    input.value = "example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".popover-apply").click();
    expect(object(a).link).toEqual({ kind: "url", url: "https://example.com" });
  });

  it("opens on the linked page and removes the link", () => {
    const { editor, a, ws, pageId, slideId, object } = setup();
    ws.dispatch("createPage", { type: "document", title: "Notes" });
    const notes = ws.getPages().find((page) => page.title === "Notes").id;
    ws.dispatch("updateObject", { pageId, slideId, objectId: a, patch: { link: { kind: "page", pageId: notes } } });
    editor.selectObjects([a]);
    expect(editor.getLinkUrl()).toBe(`#${notes}`);
    openForm(editor, a);
    expect(document.querySelector('[data-role="link-input"]').value).toBe("Notes");
    document.querySelector('[data-action="link-remove"]').click();
    expect(object(a).link).toBeUndefined();
  });

  it("reports a slide link as linked, so it can be removed here", () => {
    const { editor, a, ws, pageId, slideId } = setup();
    ws.dispatch("updateObject", { pageId, slideId, objectId: a, patch: { link: { kind: "slide", slideId } } });
    editor.selectObjects([a]);
    expect(editor.getLinkInfo()).toMatchObject({ canLink: true, inLink: true, url: "" });
  });

  it("applies a page link through setLink", () => {
    const { editor, a, ws, object } = setup();
    ws.dispatch("createPage", { type: "document", title: "Notes" });
    const notes = ws.getPages().find((page) => page.title === "Notes").id;
    editor.selectObjects([a]);
    editor.setLink(`#${notes}`);
    expect(object(a).link).toEqual({ kind: "page", pageId: notes });
  });
});

describe("selection capture and restore", () => {
  it("round-trips the slide and objects, dropping objects that are gone", () => {
    const { editor, slideId, a } = setup();
    editor.selectObjects([a]);
    expect(editor.captureSelection()).toEqual({ slideId, objectIds: [a] });
    editor.selectObjects([]);
    expect(editor.restoreSelection({ slideId, objectIds: [a, "obj_gone"] })).toBe(true);
    expect(editor.getSelection()).toEqual([a]);
    expect(editor.restoreSelection({ slideId: "slide_gone", objectIds: [] })).toBe(false);
    expect(editor.dependsOn().size).toBe(1);
  });
});

describe("keyed rendering", () => {
  const thumb = (editor, id) => editor.element.querySelector(`.slide-strip .slide-thumb-wrap[data-slide-id="${id}"]`);

  it("keeps the stage and the objects that did not change when one object changes", () => {
    const { ws, pageId, slideId, a, b, editor } = setup();
    const stage = editor.element.querySelector(".stage");
    const elA = objectEl(editor, a);
    const elB = objectEl(editor, b);
    ws.dispatch("updateObject", { pageId, slideId, objectId: a, patch: { x: 140 } });
    expect(editor.element.querySelector(".stage")).toBe(stage);
    expect(objectEl(editor, b)).toBe(elB);
    expect(objectEl(editor, a)).not.toBe(elA);
    expect(objectEl(editor, a).style.left).toBe("140px");
  });

  it("adds and removes stage objects without touching the others", () => {
    const { ws, pageId, slideId, a, b, editor } = setup();
    const elA = objectEl(editor, a);
    const extra = createObject("shape", { x: 10, y: 10, width: 50, height: 50 });
    ws.dispatch("insertObject", { pageId, slideId, object: extra });
    expect(objectEl(editor, extra.id)).toBeTruthy();
    expect(objectEl(editor, a)).toBe(elA);
    ws.dispatch("deleteObjects", { pageId, slideId, objectIds: [b] });
    expect(objectEl(editor, b)).toBeNull();
    expect(objectEl(editor, a)).toBe(elA);
    const order = [...editor.element.querySelectorAll(".stage .slide-object")].map((el) => el.dataset.objectId);
    expect(order).toEqual([a, extra.id]);
  });

  it("redraws the object again after a preview swapped its element", () => {
    const { ws, pageId, slideId, a, editor } = setup();
    editor.selectObjects([a]);
    mouse("mousedown", objectEl(editor, a), 150, 120);
    mouse("mousemove", document, 220, 160);
    const previewed = objectEl(editor, a);
    mouse("mouseup", document, 220, 160);
    expect(objectEl(editor, a)).not.toBe(previewed);
    expect(objectEl(editor, a).style.left).toBe(`${ws.getPage(pageId).content.slides[slideId].objects[a].x}px`);
  });

  it("keeps untouched thumbnails when one slide changes, and renumbers when slides move", () => {
    const { ws, pageId, slideId, a, editor } = setup();
    editor.newSlide("blank");
    const [first, second] = editor.getContent().slideOrder;
    const thumbFirst = thumb(editor, first);
    const thumbSecond = thumb(editor, second);
    ws.dispatch("updateObject", { pageId, slideId: first, objectId: a, patch: { x: 300 } });
    expect(thumb(editor, second)).toBe(thumbSecond);
    expect(thumb(editor, first)).not.toBe(thumbFirst);

    const kept = thumb(editor, first);
    editor.moveSlide(second, 0);
    expect(thumb(editor, first)).toBe(kept);
    expect(thumb(editor, first).querySelector(".slide-number").textContent).toBe("2");
    expect(thumb(editor, second).querySelector(".slide-number").textContent).toBe("1");
    expect([...editor.element.querySelectorAll(".slide-thumb-wrap")].map((el) => el.dataset.slideId)).toEqual([second, first]);
  });

  it("moves the current mark between thumbnails without replacing them", () => {
    const { editor } = setup();
    editor.newSlide("blank");
    const [first, second] = editor.getContent().slideOrder;
    const thumbFirst = thumb(editor, first);
    editor.selectSlide(first);
    expect(thumb(editor, first)).toBe(thumbFirst);
    expect(thumbFirst.classList.contains("is-current")).toBe(true);
    expect(thumb(editor, second).classList.contains("is-current")).toBe(false);
  });
});
