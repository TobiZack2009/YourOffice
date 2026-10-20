import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerPresentationCommands } from "../src/presentation/commands.js";
import { createAnimation, createObject } from "../src/presentation/model.js";
import { PREVIEW_STEP_PAUSE } from "../src/presentation/animation.js";
import { createPresentationEditor } from "../src/app/presentation-editor.js";
import { createPreview, PREVIEW_HOLD } from "../src/app/animation-preview.js";
import { createAnimationTimeline, effectLabel, formatMs, objectLabel } from "../src/app/animation-timeline.js";

/** jsdom has no layout, so client coordinates are slide coordinates (scale 1). */
function setup(view = { inspector: true, snap: false, grid: false, timeline: true }) {
  const ws = Workspace.create({ title: "W" });
  registerPresentationCommands(ws);
  ws.dispatch("createPage", { type: "presentation", title: "Deck" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createSlide", { pageId, layout: "blank" });
  const slideId = ws.getPage(pageId).content.slideOrder[0];
  const add = (type, fields) => {
    const object = createObject(type, fields);
    ws.dispatch("insertObject", { pageId, slideId, object });
    return object.id;
  };
  const a = add("shape", { x: 100, y: 100, width: 200, height: 100 });
  const b = add("text", { x: 500, y: 300, width: 300, height: 80 });
  const editor = createPresentationEditor(ws, pageId, { view });
  document.body.append(editor.element);
  const slide = () => ws.getPage(pageId).content.slides[slideId];
  return { ws, pageId, slideId, a, b, editor, slide };
}

const mouse = (type, target, x, y) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

const rows = (editor) => [...editor.element.querySelectorAll(".animation-row")];

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  delete Element.prototype.animate;
});

describe("editing animations from the ribbon", () => {
  it("replaces the selected animation's effect instead of adding another", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("appear");
    const [id] = slide().animationOrder;
    expect(editor.applyAnimationEffect("fade-in")).toBe(true);
    expect(slide().animationOrder).toEqual([id]);
    // Appear is instant, so switching to Fade in follows the new default duration.
    expect(slide().animations[id]).toMatchObject({ effect: "fade-in", duration: 500 });
    editor.applyAnimationEffect("slide-in", { direction: "up" });
    expect(slide().animations[id]).toMatchObject({ effect: "slide-in", direction: "up" });
    editor.applyAnimationEffect("slide-in", { direction: "right" });
    expect(slide().animations[id].direction).toBe("right");
    expect(slide().animationOrder).toEqual([id]);
  });

  it("keeps a custom duration when the effect changes", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    const [id] = slide().animationOrder;
    editor.updateAnimation({ duration: 1234 });
    editor.applyAnimationEffect("motion");
    expect(slide().animations[id]).toMatchObject({ effect: "motion", duration: 1234 });
    expect(slide().animations[id].path).toBeTruthy();
  });

  it("does nothing when the effect is already set", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    const before = JSON.stringify(slide().animations);
    expect(editor.applyAnimationEffect("fade-in")).toBe(true);
    expect(slide().animationOrder).toHaveLength(1);
    expect(JSON.stringify(slide().animations)).toBe(before);
  });

  it("adds a new animation when the selected one belongs to another object", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("appear");
    editor.selectObjects([b]);
    // Selecting b drops a's animation from the selection.
    expect(editor.getSelectedAnimation()).toBeNull();
    editor.applyAnimationEffect("fade-in");
    expect(slide().animationOrder).toHaveLength(2);
    expect(editor.getAnimations().map((x) => x.objectId)).toEqual([a, b]);
  });

  it("changes the selected animation from the timeline with no object selected", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("appear");
    editor.selectObjects([]);
    expect(editor.getSelectedAnimation()).not.toBeNull();
    editor.applyAnimationEffect("fade-in");
    expect(slide().animationOrder).toHaveLength(1);
    expect(editor.getAnimations()[0].effect).toBe("fade-in");
  });

  it("selects an object's animation when the object is selected", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("appear");
    editor.addAnimation("fade-in"); // a's second animation (replaces nothing: add)
    editor.selectObjects([b]);
    editor.addAnimation("appear");
    const [a1, a2, b1] = slide().animationOrder;
    editor.selectObjects([a]);
    expect(editor.getSelectedAnimation().id).toBe(a1);
    // An animation picked on the timeline stays while its object is selected.
    editor.selectAnimation(a2);
    editor.selectObjects([a, b]);
    expect(editor.getSelectedAnimation().id).toBe(a2);
    editor.selectObjects([b]);
    expect(editor.getSelectedAnimation().id).toBe(b1);
  });

  it("lists the slide's animations for the picker", () => {
    const { editor, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("appear");
    editor.selectObjects([b]);
    editor.addAnimation("slide-in", { direction: "left" });
    const list = editor.describeAnimations();
    expect(list.map((x) => [x.number, x.selected])).toEqual([[1, false], [2, true]]);
    expect(list[0].label).toBe("Appear · Rectangle");
    expect(list[1].label).toContain("Slide in from left");
  });
});

describe("editor animation handle", () => {
  it("animates the selected objects: the first on click, the rest with it", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a, b]);
    expect(editor.addAnimation("fade-in")).toBe(true);
    const list = editor.getAnimations();
    expect(list.map((x) => [x.objectId, x.trigger, x.effect])).toEqual([
      [a, "click", "fade-in"],
      [b, "with", "fade-in"]
    ]);
    expect(slide().animationOrder).toHaveLength(2);
    // The last new animation takes the selection.
    expect(editor.getSelectedAnimation().id).toBe(list[1].id);
  });

  it("does nothing without a selected object", () => {
    const { editor, slide } = setup();
    expect(editor.addAnimation("appear")).toBe(false);
    expect(slide().animationOrder).toEqual([]);
  });

  it("adds one undoable transaction for a multi-selection", () => {
    const { editor, ws, slide, a, b } = setup();
    editor.selectObjects([a, b]);
    editor.addAnimation("appear");
    expect(slide().animationOrder).toHaveLength(2);
    ws.undo();
    expect(slide().animationOrder).toHaveLength(0);
  });

  it("updates, moves and removes animations", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    editor.selectObjects([b]);
    editor.addAnimation("slide-in", { direction: "right" });
    const [first, second] = slide().animationOrder;
    expect(slide().animations[second].direction).toBe("right");

    expect(editor.updateAnimation({ delay: 250, trigger: "after" })).toBe(true);
    expect(slide().animations[second]).toMatchObject({ delay: 250, trigger: "after" });

    expect(editor.moveSelectedAnimation(-1)).toBe(true);
    expect(slide().animationOrder).toEqual([second, first]);

    expect(editor.removeAnimation()).toBe(true);
    expect(slide().animationOrder).toEqual([first]);
    // The neighbour takes the selection.
    expect(editor.getSelectedAnimation().id).toBe(first);
  });

  it("rejects an invalid patch without changing anything", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    const before = structuredClone(slide().animations);
    expect(editor.updateAnimation({ duration: -5 })).toBe(false);
    expect(slide().animations).toEqual(before);
  });

  it("drops the animation selection when its animation is deleted with its object", () => {
    const { editor, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    editor.deleteSelected();
    expect(editor.getAnimations()).toEqual([]);
    expect(editor.getSelectedAnimation()).toBeNull();
  });
});

describe("timeline panel", () => {
  it("lists the animations in order and shows an empty state", () => {
    const { editor, a, b } = setup();
    expect(editor.element.querySelector('[data-role="timeline-empty"]')).toBeTruthy();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    editor.selectObjects([b]);
    editor.addAnimation("slide-in", { direction: "up" });
    expect(editor.element.querySelector('[data-role="timeline-empty"]')).toBeNull();
    expect(editor.element.querySelector('[data-role="timeline-count"]').textContent).toBe("2");
    expect(rows(editor).map((r) => r.dataset.effect)).toEqual(["fade-in", "slide-in"]);
    expect(rows(editor)[1].querySelector('[data-field="effect"]').value).toBe("slide-in");
    expect(rows(editor)[1].querySelector('[data-field="direction"]').value).toBe("up");
    expect(rows(editor)[0].querySelector('[data-field="direction"]')).toBeNull();
    expect(rows(editor)[1].classList.contains("is-selected")).toBe(true);
  });

  const change = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("edits an existing animation in place: start, effect, direction, delay, duration", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("appear");
    const id = slide().animationOrder[0];
    const field = (name) => rows(editor)[0].querySelector(`[data-field="${name}"]`);

    change(field("trigger"), "after");
    expect(slide().animations[id].trigger).toBe("after");

    // Appear (0 ms) to Fade in picks up the new effect's default duration.
    change(field("effect"), "fade-in");
    expect(slide().animations[id]).toMatchObject({ effect: "fade-in", duration: 500 });

    change(field("effect"), "slide-in");
    expect(slide().animations[id]).toMatchObject({ effect: "slide-in", direction: "left" });
    change(field("direction"), "down");
    expect(slide().animations[id].direction).toBe("down");

    change(field("delay"), "250");
    change(field("duration"), "1200");
    expect(slide().animations[id]).toMatchObject({ delay: 250, duration: 1200 });
    expect(field("delay").value).toBe("250");

    change(field("effect"), "motion");
    expect(slide().animations[id].path).toBeTruthy();
    expect(field("direction")).toBeNull();
  });

  it("keeps a custom duration when the effect changes, and reverts a refused value", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    const id = slide().animationOrder[0];
    const field = (name) => rows(editor)[0].querySelector(`[data-field="${name}"]`);
    change(field("duration"), "900");
    change(field("effect"), "slide-in");
    expect(slide().animations[id].duration).toBe(900);

    change(field("duration"), "999999");
    expect(slide().animations[id].duration).toBe(900);
    expect(field("duration").value).toBe("900");
    change(field("delay"), "");
    expect(field("delay").value).toBe("0");
  });

  it("selects a row when one of its fields is used, without rebuilding the row", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    editor.selectObjects([b]);
    editor.addAnimation("appear");
    const [first] = slide().animationOrder;
    const row = rows(editor)[0];
    const select = row.querySelector('[data-field="trigger"]');
    select.focus();
    expect(editor.getSelectedAnimation().id).toBe(first);
    // The same element survives, so an open native dropdown would not close.
    expect(rows(editor)[0]).toBe(row);
    expect(row.classList.contains("is-selected")).toBe(true);
  });

  it("keeps focus in a field across the re-render its edit causes, and Backspace does not delete the row", () => {
    const { editor, slide, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    const input = rows(editor)[0].querySelector('[data-field="delay"]');
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    expect(slide().animationOrder).toHaveLength(1);
    change(input, "300");
    const again = rows(editor)[0].querySelector('[data-field="delay"]');
    expect(again).not.toBe(input);
    expect(document.activeElement).toBe(again);
  });

  it("selects a row on click, and moves or deletes with its buttons", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    editor.selectObjects([b]);
    editor.addAnimation("appear");
    const [first, second] = slide().animationOrder;

    rows(editor)[0].click();
    expect(editor.getSelectedAnimation().id).toBe(first);

    rows(editor)[0].querySelector('[data-action="animation-down"]').click();
    expect(slide().animationOrder).toEqual([second, first]);
    expect(rows(editor)[0].querySelector('[data-action="animation-up"]').disabled).toBe(true);

    rows(editor)[1].querySelector('[data-action="animation-delete"]').click();
    expect(slide().animationOrder).toEqual([second]);
  });

  it("reorders by dragging a row onto another", () => {
    const { editor, slide, a, b } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("fade-in");
    editor.selectObjects([b]);
    editor.addAnimation("appear");
    const [first, second] = slide().animationOrder;
    const [rowA, rowB] = rows(editor);
    rowA.dispatchEvent(new Event("dragstart", { bubbles: true }));
    // jsdom rects are zero-sized, so the drop lands "before" the target: put row A before row A is a no-op,
    // and dropping row B onto row A moves it first.
    rowB.dispatchEvent(new Event("dragstart", { bubbles: true }));
    rowA.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(slide().animationOrder).toEqual([second, first]);
  });

  it("shows the timeline only when the view asks for it", () => {
    const { editor } = setup();
    expect(editor.element.classList.contains("show-timeline")).toBe(true);
    editor.setView({ timeline: false });
    expect(editor.element.classList.contains("show-timeline")).toBe(false);
  });

  it("renders from the model with the pure helpers", () => {
    expect(formatMs(1500)).toBe("1.5s");
    expect(formatMs(0)).toBe("0s");
    expect(effectLabel(createAnimation({ objectId: "o", effect: "slide-in", direction: "down" }))).toBe("Slide in from bottom");
    expect(objectLabel(undefined)).toBe("Missing object");
    expect(objectLabel({ type: "shape", shape: "ellipse" })).toBe("Ellipse");
    expect(objectLabel({ type: "text", name: "Title" })).toBe("Title");
  });

  it("works standalone against a plain API", () => {
    const onSelect = vi.fn();
    const object = createObject("shape", { x: 0, y: 0, width: 10, height: 10 });
    const animation = createAnimation({ objectId: object.id, effect: "appear" });
    const slide = { objects: { [object.id]: object }, animations: { [animation.id]: animation }, animationOrder: [animation.id] };
    const timeline = createAnimationTimeline({
      getSlide: () => slide,
      getSelectedId: () => null,
      isPreviewing: () => false,
      onSelect,
      onMove: vi.fn(),
      onDelete: vi.fn(),
      onTogglePreview: vi.fn()
    });
    timeline.render();
    timeline.element.querySelector(".animation-row").click();
    expect(onSelect).toHaveBeenCalledWith(animation.id);
  });
});

describe("stage overlay", () => {
  it("numbers animated objects and draws motion paths with draggable ends", () => {
    const { editor, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("motion");
    const overlay = editor.element.querySelector(".stage-overlay");
    expect(overlay.querySelectorAll(".animation-tag")).toHaveLength(1);
    expect(overlay.querySelector(".motion-line")).toBeTruthy();
    expect(overlay.querySelectorAll("[data-path-handle]")).toHaveLength(2);
    expect(overlay.querySelector(".animation-target")).toBeTruthy();
  });

  it("leaves the overlay alone when the timeline is hidden", () => {
    const { editor, a } = setup({ inspector: true, snap: false, grid: false, timeline: false });
    editor.selectObjects([a]);
    editor.addAnimation("motion");
    const overlay = editor.element.querySelector(".stage-overlay");
    expect(overlay.querySelector(".animation-tag")).toBeNull();
    expect(overlay.querySelector("[data-path-handle]")).toBeNull();
  });

  it("commits one updateAnimation when a motion endpoint is dragged", () => {
    const { editor, slide, ws, a } = setup();
    editor.selectObjects([a]);
    editor.addAnimation("motion");
    const id = editor.getSelectedAnimation().id;
    // Object centre is (200, 150); the default path ends 240 px to the right.
    const handle = editor.element.querySelector('[data-path-handle="to"]');
    const history = ws.canUndo;
    expect(history).toBe(true);
    mouse("mousedown", handle, 440, 150);
    mouse("mousemove", document, 500, 200);
    // Nothing is committed mid-drag.
    expect(slide().animations[id].path.to).toEqual({ x: 240, y: 0 });
    mouse("mouseup", document, 500, 200);
    expect(slide().animations[id].path).toEqual({ from: { x: 0, y: 0 }, to: { x: 300, y: 50 } });
    ws.undo();
    expect(slide().animations[id].path.to).toEqual({ x: 240, y: 0 });
  });
});

describe("preview", () => {
  function deck({ withAnimate }) {
    const ctx = setup();
    if (withAnimate) {
      const calls = [];
      Element.prototype.animate = function animate(keyframes, options) {
        const handle = { cancel: vi.fn() };
        calls.push({ el: this, keyframes, options, handle });
        return handle;
      };
      ctx.calls = calls;
    }
    ctx.editor.selectObjects([ctx.a]);
    ctx.editor.addAnimation("fade-in");
    ctx.editor.selectObjects([ctx.b]);
    ctx.editor.addAnimation("slide-in", { direction: "left", trigger: "click" });
    ctx.el = (id) => ctx.editor.element.querySelector(`.stage .slide-object[data-object-id="${id}"]`);
    return ctx;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("hides entrance objects, reveals them in step order, then restores everything", () => {
    const { editor, el, a, b, calls } = deck({ withAnimate: true });
    expect(editor.startPreview()).toBe(true);
    expect(editor.isPreviewing()).toBe(true);
    expect(el(a).style.visibility).toBe("hidden");
    expect(el(b).style.visibility).toBe("hidden");

    vi.advanceTimersByTime(0);
    expect(el(a).style.visibility).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(calls[0].options).toMatchObject({ duration: 500, fill: "both" });
    expect(el(b).style.visibility).toBe("hidden");

    // The second click step plays on its own after the first ends plus the pause.
    vi.advanceTimersByTime(500 + PREVIEW_STEP_PAUSE);
    expect(calls).toHaveLength(2);
    expect(el(b).style.visibility).toBe("");

    vi.advanceTimersByTime(500 + PREVIEW_HOLD);
    expect(editor.isPreviewing()).toBe(false);
    expect(calls.every((call) => call.handle.cancel.mock.calls.length === 1)).toBe(true);
    expect(el(a).style.visibility).toBe("");
    expect(el(b).style.translate).toBe("");
  });

  it("stops on Escape and clears pending steps", () => {
    const { editor, el, a, b, calls } = deck({ withAnimate: true });
    editor.startPreview();
    vi.advanceTimersByTime(0);
    editor.element
      .querySelector(".stage-area")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(editor.isPreviewing()).toBe(false);
    expect(el(a).style.visibility).toBe("");
    expect(el(b).style.visibility).toBe("");
    vi.advanceTimersByTime(10000);
    expect(calls).toHaveLength(1);
  });

  it("stops when the model changes or the slide is replaced", () => {
    const { editor } = deck({ withAnimate: true });
    editor.startPreview();
    editor.updateAnimation({ delay: 100 });
    expect(editor.isPreviewing()).toBe(false);
  });

  it("falls back without the Web Animations API: reveals objects and parks motion at its end", () => {
    const ctx = setup();
    ctx.editor.selectObjects([ctx.a]);
    ctx.editor.addAnimation("motion");
    ctx.editor.updateAnimation({ path: { from: { x: 0, y: 0 }, to: { x: 40, y: 10 } } });
    const el = ctx.editor.element.querySelector(`.stage .slide-object[data-object-id="${ctx.a}"]`);
    ctx.editor.startPreview();
    vi.advanceTimersByTime(0);
    expect(el.style.translate).toBe("40px 10px");
    vi.advanceTimersByTime(1000 + PREVIEW_HOLD);
    expect(el.style.translate).toBe("");
    expect(ctx.editor.isPreviewing()).toBe(false);
  });

  it("refuses to preview a slide without animations", () => {
    const { editor } = setup();
    expect(editor.startPreview()).toBe(false);
    expect(editor.isPreviewing()).toBe(false);
  });
});

describe("createPreview", () => {
  it("calls onDone straight away when there is nothing to play", () => {
    const onDone = vi.fn();
    const preview = createPreview({
      slideEl: document.createElement("div"),
      slide: { objects: {}, animations: {}, animationOrder: [] },
      size: { width: 1280, height: 720 },
      onDone
    });
    preview.start();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(preview.isRunning()).toBe(false);
  });
});
