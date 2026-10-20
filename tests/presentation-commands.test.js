import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createObject, validatePresentationContent } from "../src/presentation/model.js";

function setup() {
  const ws = createWorkspace({ title: "W" });
  ws.dispatch("createPage", { type: "presentation", title: "Deck" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createSlide", { pageId, layout: "blank" });
  const content = () => ws.getPage(pageId).content;
  const slideId = content().slideOrder[0];
  const slide = () => content().slides[slideId];
  const add = (type = "shape", fields = {}) => {
    const object = createObject(type, { x: 100, y: 100, width: 200, height: 100, ...fields });
    ws.dispatch("insertObject", { pageId, slideId, object });
    return object.id;
  };
  return { ws, pageId, slideId, content, slide, add };
}

const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.reason;
  }
  return null;
};

describe("slides", () => {
  it("creates slides from layouts at an index, with stable ids", () => {
    const { ws, pageId, content } = setup();
    ws.dispatch("createSlide", { pageId, layout: "title" });
    ws.dispatch("createSlide", { pageId, layout: "twoColumns", index: 0 });
    const order = content().slideOrder;
    expect(order).toHaveLength(3);
    expect(content().slides[order[0]].layout).toBe("twoColumns");
    expect(content().slides[order[0]].objectOrder).toHaveLength(3);
    expect(validatePresentationContent(content())).toEqual([]);
  });

  it("scales layouts to the presentation size", () => {
    const { ws, pageId, content } = setup();
    ws.dispatch("setSlideSize", { pageId, width: 640, height: 360 });
    ws.dispatch("createSlide", { pageId, layout: "titleContent" });
    const slide = content().slides[content().slideOrder.at(-1)];
    expect(slide.objects[slide.objectOrder[0]].width).toBeLessThanOrEqual(640);
  });

  it("rejects unknown layouts, pages and out-of-range indexes", () => {
    const { ws, pageId } = setup();
    expect(code(() => ws.dispatch("createSlide", { pageId, layout: "nope" }))).toBe("invalidLayout");
    expect(code(() => ws.dispatch("createSlide", { pageId, index: 9 }))).toBe("invalidIndex");
    expect(code(() => ws.dispatch("createSlide", { pageId: "ghost" }))).toBe("unknownPage");
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    const docId = ws.getChildren(null)[1];
    expect(code(() => ws.dispatch("createSlide", { pageId: docId }))).toBe("wrongPageType");
  });

  it("duplicates a slide after the original with fresh object ids", () => {
    const { ws, pageId, slideId, content, add } = setup();
    const original = add();
    ws.dispatch("duplicateSlide", { pageId, slideId });
    const [first, second] = content().slideOrder;
    expect(first).toBe(slideId);
    expect(second).not.toBe(slideId);
    const copy = content().slides[second];
    expect(copy.objectOrder).toHaveLength(1);
    expect(copy.objectOrder[0]).not.toBe(original);
    expect(copy.objects[copy.objectOrder[0]].id).toBe(copy.objectOrder[0]);
    expect(validatePresentationContent(content())).toEqual([]);
  });

  it("refuses to delete the last slide, and clears links to a deleted slide", () => {
    const { ws, pageId, slideId, content, add } = setup();
    expect(code(() => ws.dispatch("deleteSlide", { pageId, slideId }))).toBe("lastSlide");
    ws.dispatch("createSlide", { pageId, layout: "blank" });
    const other = content().slideOrder[1];
    const id = add();
    ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { link: { kind: "slide", slideId: other } } });
    ws.dispatch("deleteSlide", { pageId, slideId: other });
    expect(content().slideOrder).toEqual([slideId]);
    expect(content().slides[slideId].objects[id].link).toBeUndefined();
  });

  it("moves slides by index without changing ids", () => {
    const { ws, pageId, slideId, content } = setup();
    ws.dispatch("createSlide", { pageId, layout: "blank" });
    ws.dispatch("createSlide", { pageId, layout: "blank" });
    const [a, b, c] = content().slideOrder;
    ws.dispatch("moveSlide", { pageId, slideId: a, index: 2 });
    expect(content().slideOrder).toEqual([b, c, a]);
    ws.dispatch("moveSlide", { pageId, slideId: a, index: 0 });
    expect(content().slideOrder).toEqual([a, b, c]);
    expect(code(() => ws.dispatch("moveSlide", { pageId, slideId, index: 7 }))).toBe("invalidIndex");
  });

  it("sets backgrounds and transitions, and can apply a transition to all", () => {
    const { ws, pageId, slideId, content } = setup();
    ws.dispatch("createSlide", { pageId, layout: "blank" });
    ws.dispatch("setSlideBackground", { pageId, slideId, color: "#112233" });
    expect(content().slides[slideId].background.color).toBe("#112233");
    expect(code(() => ws.dispatch("setSlideBackground", { pageId, slideId, color: "blue" }))).toBe("invalidColor");

    ws.dispatch("setSlideTransition", { pageId, slideId, transition: { style: "wipe", direction: "up", duration: 800 } });
    expect(content().slides[slideId].transition).toEqual({ style: "wipe", direction: "up", duration: 800 });
    ws.dispatch("setSlideTransition", { pageId, slideId, transition: { duration: 200 } });
    expect(content().slides[slideId].transition.style).toBe("wipe");
    expect(code(() => ws.dispatch("setSlideTransition", { pageId, slideId, transition: { style: "spin" } }))).toBe(
      "invalidTransition"
    );
    ws.dispatch("applyTransitionToAll", { pageId, slideId });
    const other = content().slideOrder[1];
    expect(content().slides[other].transition).toEqual(content().slides[slideId].transition);
  });
});

describe("slide size", () => {
  it("changes the shared size and optionally scales every object", () => {
    const { ws, pageId, slideId, content, add, slide } = setup();
    ws.dispatch("createSlide", { pageId, layout: "blank" });
    const id = add("text", { text: { fontSize: 40, runs: [] } });
    const otherId = content().slideOrder[1];
    ws.dispatch("insertObject", { pageId, slideId: otherId, object: createObject("shape", { x: 10, y: 10, width: 100, height: 50 }) });

    ws.dispatch("setSlideSize", { pageId, width: 640, height: 360, scaleContent: true });
    expect(content().size).toEqual({ width: 640, height: 360 });
    expect(slide().objects[id]).toMatchObject({ x: 50, y: 50, width: 100, height: 50 });
    expect(slide().objects[id].text.fontSize).toBe(20);
    const second = content().slides[otherId];
    expect(second.objects[second.objectOrder[0]].width).toBe(50);
  });

  it("keeps content as is when not scaling, and scales fonts by the smaller ratio", () => {
    const { ws, pageId, add, slide } = setup();
    const id = add("text", { text: { fontSize: 40, runs: [] } });
    ws.dispatch("setSlideSize", { pageId, width: 1024, height: 768 });
    expect(slide().objects[id]).toMatchObject({ x: 100, width: 200 });
    ws.dispatch("setSlideSize", { pageId, width: 512, height: 768, scaleContent: true });
    expect(slide().objects[id].width).toBe(100);
    expect(slide().objects[id].text.fontSize).toBe(20);
  });

  it("validates bounds and is one undoable step", () => {
    const { ws, pageId, content, add, slide } = setup();
    const id = add();
    expect(code(() => ws.dispatch("setSlideSize", { pageId, width: 100, height: 720 }))).toBe("invalidSize");
    expect(code(() => ws.dispatch("setSlideSize", { pageId, width: 9000, height: 720 }))).toBe("invalidSize");
    expect(code(() => ws.dispatch("setSlideSize", { pageId, width: "x", height: 720 }))).toBe("invalidSize");
    ws.dispatch("setSlideSize", { pageId, width: 640, height: 360, scaleContent: true });
    ws.undo();
    expect(content().size).toEqual({ width: 1280, height: 720 });
    expect(slide().objects[id].width).toBe(200);
  });
});

describe("objects", () => {
  it("inserts on top, validates, and rejects duplicate ids", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    const b = add("text");
    expect(slide().objectOrder).toEqual([a, b]);
    expect(code(() => ws.dispatch("insertObject", { pageId, slideId, object: { ...createObject("shape"), width: -1 } }))).toBe(
      "invalidObject"
    );
    expect(code(() => ws.dispatch("insertObject", { pageId, slideId, object: slide().objects[a] }))).toBe(
      "duplicateObject"
    );
    ws.dispatch("insertObject", { pageId, slideId, object: createObject("line"), index: 0 });
    expect(slide().objectOrder[0]).not.toBe(a);
  });

  it("patches whitelisted fields only, and validates the result", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const id = add();
    ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { x: 5, rotation: 45, fill: "#ff0000" } });
    expect(slide().objects[id]).toMatchObject({ x: 5, rotation: 45, fill: "#ff0000" });
    expect(code(() => ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { id: "other" } }))).toBe("invalidPatch");
    expect(code(() => ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { type: "text" } }))).toBe("invalidPatch");
    expect(code(() => ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { width: 0 } }))).toBe("invalidObject");
    expect(slide().objects[id].width).toBe(200);
    expect(code(() => ws.dispatch("updateObject", { pageId, slideId, objectId: "ghost", patch: { x: 1 } }))).toBe("unknownObject");
  });

  it("merges text patches and removes links with null", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const id = add("text", { text: { runs: [{ text: "hi" }] } });
    ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { text: { fontSize: 50 } } });
    expect(slide().objects[id].text).toMatchObject({ fontSize: 50, runs: [{ text: "hi" }] });
    ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { link: { kind: "url", url: "https://a.test" } } });
    expect(slide().objects[id].link.url).toBe("https://a.test");
    ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { link: null } });
    expect(slide().objects[id].link).toBeUndefined();
  });

  it("updates several objects in one transaction", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    const b = add();
    ws.dispatch("updateObjects", {
      pageId,
      slideId,
      items: [
        { objectId: a, patch: { x: 1 } },
        { objectId: b, patch: { x: 2 } }
      ]
    });
    expect([slide().objects[a].x, slide().objects[b].x]).toEqual([1, 2]);
    // One failing item rolls back the whole step.
    expect(
      code(() =>
        ws.dispatch("updateObjects", {
          pageId,
          slideId,
          items: [
            { objectId: a, patch: { x: 99 } },
            { objectId: b, patch: { width: -5 } }
          ]
        })
      )
    ).toBe("invalidObject");
    expect(slide().objects[a].x).toBe(1);
    ws.undo();
    expect(slide().objects[a].x).toBe(100);
  });

  it("commits text runs for text objects and shape labels, not lines", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const text = add("text");
    const shape = add("shape");
    const line = add("line");
    ws.dispatch("setObjectRuns", { pageId, slideId, objectId: text, runs: [{ text: "Hello", marks: { bold: true } }] });
    expect(slide().objects[text].text.runs).toEqual([{ text: "Hello", marks: { bold: true } }]);
    ws.dispatch("setObjectRuns", { pageId, slideId, objectId: shape, runs: [{ text: "Label" }] });
    expect(slide().objects[shape].text.align).toBe("center");
    expect(code(() => ws.dispatch("setObjectRuns", { pageId, slideId, objectId: line, runs: [] }))).toBe("invalidObject");
    expect(code(() => ws.dispatch("setObjectRuns", { pageId, slideId, objectId: text, runs: [{ text: "" }] }))).toBe("invalidRuns");
  });

  it("deletes objects and keeps order consistent", () => {
    const { ws, pageId, slideId, content, slide, add } = setup();
    const a = add();
    const b = add();
    const c = add();
    ws.dispatch("deleteObjects", { pageId, slideId, objectIds: [a, c] });
    expect(slide().objectOrder).toEqual([b]);
    expect(Object.keys(slide().objects)).toEqual([b]);
    expect(code(() => ws.dispatch("deleteObjects", { pageId, slideId, objectIds: [] }))).toBe("invalidObject");
    expect(validatePresentationContent(content())).toEqual([]);
  });

  it("duplicates and pastes with fresh ids and an offset", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    const b = add();
    ws.dispatch("duplicateObjects", { pageId, slideId, objectIds: [b, a] });
    const order = slide().objectOrder;
    expect(order).toHaveLength(4);
    // Relative stacking of the originals is preserved.
    expect(slide().objects[order[2]].x).toBe(124);
    expect(order.slice(2)).not.toContain(a);

    const clipboard = [structuredClone(slide().objects[a])];
    ws.dispatch("pasteObjects", { pageId, slideId, objects: clipboard, newIds: ["obj_fixed"], offset: 0 });
    expect(slide().objects.obj_fixed.x).toBe(100);
    ws.dispatch("pasteObjects", { pageId, slideId, objects: clipboard });
    expect(slide().objectOrder).toHaveLength(6);
    expect(code(() => ws.dispatch("pasteObjects", { pageId, slideId, objects: [] }))).toBe("invalidObject");
  });

  it("restacks objects, keeping ids", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const [a, b, c, d] = [add(), add(), add(), add()];
    const op = (objectIds, name) => ws.dispatch("reorderObjects", { pageId, slideId, objectIds, op: name });
    op([a], "front");
    expect(slide().objectOrder).toEqual([b, c, d, a]);
    op([a], "back");
    expect(slide().objectOrder).toEqual([a, b, c, d]);
    op([a], "forward");
    expect(slide().objectOrder).toEqual([b, a, c, d]);
    op([a, c], "forward");
    expect(slide().objectOrder).toEqual([b, d, a, c]);
    op([d], "backward");
    expect(slide().objectOrder).toEqual([d, b, a, c]);
    op([d, b], "backward");
    expect(slide().objectOrder).toEqual([d, b, a, c]);
    expect(code(() => op([a], "sideways"))).toBe("invalidOp");
  });

  it("is undoable and redoable as whole transactions", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const id = add();
    ws.dispatch("updateObject", { pageId, slideId, objectId: id, patch: { x: 7 } });
    ws.undo();
    expect(slide().objects[id].x).toBe(100);
    ws.redo();
    expect(slide().objects[id].x).toBe(7);
  });
});

describe("animations", () => {
  const anim = (objectId, extra = {}) => ({ objectId, effect: "fade-in", ...extra });

  it("adds animations in order with defaults, and is undoable", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    const b = add();
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a) });
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(b, { effect: "slide-in", trigger: "with" }) });
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a, { effect: "appear" }), index: 0 });
    const order = slide().animationOrder;
    expect(order).toHaveLength(3);
    expect(slide().animations[order[0]].effect).toBe("appear");
    expect(slide().animations[order[2]]).toMatchObject({ trigger: "with", direction: "left", duration: 500 });
    expect(validatePresentationContent(ws.getPage(pageId).content)).toEqual([]);
    ws.undo();
    expect(slide().animationOrder).toHaveLength(2);
  });

  it("rejects unknown objects, bad fields, bad indexes and duplicate ids", () => {
    const { ws, pageId, slideId, add } = setup();
    const a = add();
    const send = (animation, index) => () => ws.dispatch("addAnimation", { pageId, slideId, animation, index });
    expect(code(send(anim("obj_ghost")))).toBe("unknownObject");
    expect(code(send(anim(a, { effect: "spin" })))).toBe("invalidAnimation");
    expect(code(send(anim(a, { duration: -5 })))).toBe("invalidAnimation");
    expect(code(send(anim(a), 5))).toBe("invalidIndex");
    expect(code(send(null))).toBe("invalidAnimation");
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a, { id: "anim_fixed" }) });
    expect(code(send(anim(a, { id: "anim_fixed" })))).toBe("duplicateAnimation");
  });

  it("updates whitelisted fields and swaps effect-specific data", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a) });
    const id = slide().animationOrder[0];
    const update = (patch) => ws.dispatch("updateAnimation", { pageId, slideId, animationId: id, patch });
    update({ delay: 250, trigger: "after" });
    expect(slide().animations[id]).toMatchObject({ delay: 250, trigger: "after" });
    update({ effect: "motion" });
    expect(slide().animations[id].path).toEqual({ from: { x: 0, y: 0 }, to: { x: 240, y: 0 } });
    update({ path: { from: { x: 0, y: 0 }, to: { x: 5, y: 6 } } });
    expect(slide().animations[id].path.to).toEqual({ x: 5, y: 6 });
    update({ effect: "slide-in", direction: "up" });
    expect(slide().animations[id].path).toBeUndefined();
    expect(slide().animations[id].direction).toBe("up");
    update({ effect: "appear" });
    expect(slide().animations[id].direction).toBeUndefined();
    expect(validatePresentationContent(ws.getPage(pageId).content)).toEqual([]);

    expect(code(() => update({ objectId: "x" }))).toBe("invalidPatch");
    expect(code(() => update({ id: "x" }))).toBe("invalidPatch");
    expect(code(() => update({ delay: -1 }))).toBe("invalidAnimation");
    expect(code(() => update({ effect: "wiggle" }))).toBe("invalidAnimation");
    expect(code(() => ws.dispatch("updateAnimation", { pageId, slideId, animationId: "anim_ghost", patch: {} }))).toBe("unknownAnimation");
  });

  it("deletes and moves animations", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    for (const effect of ["appear", "fade-in", "slide-in"]) {
      ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a, { effect }) });
    }
    const [first, second, third] = slide().animationOrder;
    ws.dispatch("moveAnimation", { pageId, slideId, animationId: third, index: 0 });
    expect(slide().animationOrder).toEqual([third, first, second]);
    ws.dispatch("moveAnimation", { pageId, slideId, animationId: third, index: 0 });
    expect(code(() => ws.dispatch("moveAnimation", { pageId, slideId, animationId: third, index: 9 }))).toBe("invalidIndex");
    expect(code(() => ws.dispatch("moveAnimation", { pageId, slideId, animationId: "anim_ghost", index: 0 }))).toBe("unknownAnimation");
    ws.dispatch("deleteAnimation", { pageId, slideId, animationId: first });
    expect(slide().animationOrder).toEqual([third, second]);
    expect(slide().animations[first]).toBeUndefined();
    ws.undo();
    expect(slide().animationOrder).toEqual([third, first, second]);
  });

  it("deleting an object removes its animations", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    const b = add();
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a) });
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(b) });
    ws.dispatch("deleteObjects", { pageId, slideId, objectIds: [a] });
    expect(slide().animationOrder).toHaveLength(1);
    expect(Object.values(slide().animations)[0].objectId).toBe(b);
    expect(validatePresentationContent(ws.getPage(pageId).content)).toEqual([]);
    ws.undo();
    expect(slide().animationOrder).toHaveLength(2);
  });

  it("duplicating a slide remaps animation and object ids; duplicating objects does not copy them", () => {
    const { ws, pageId, slideId, content, slide, add } = setup();
    const a = add();
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a) });
    const original = slide().animationOrder[0];
    ws.dispatch("duplicateSlide", { pageId, slideId });
    const copy = content().slides[content().slideOrder[1]];
    expect(copy.animationOrder).toHaveLength(1);
    const copied = copy.animations[copy.animationOrder[0]];
    expect(copied.id).not.toBe(original);
    expect(copy.objects[copied.objectId]).toBeDefined();
    expect(copied.objectId).not.toBe(a);
    expect(slide().animations[original].objectId).toBe(a);
    expect(validatePresentationContent(content())).toEqual([]);

    ws.dispatch("duplicateObjects", { pageId, slideId, objectIds: [a] });
    ws.dispatch("pasteObjects", { pageId, slideId, objects: [slide().objects[a]] });
    expect(slide().animationOrder).toHaveLength(1);
  });

  it("scales motion offsets with the slide size", () => {
    const { ws, pageId, slideId, slide, add } = setup();
    const a = add();
    ws.dispatch("addAnimation", { pageId, slideId, animation: anim(a, { effect: "motion", path: { from: { x: 0, y: 0 }, to: { x: 200, y: 100 } } }) });
    ws.dispatch("setSlideSize", { pageId, width: 640, height: 360, scaleContent: true });
    expect(Object.values(slide().animations)[0].path.to).toEqual({ x: 100, y: 50 });
    ws.dispatch("setSlideSize", { pageId, width: 320, height: 360 });
    expect(Object.values(slide().animations)[0].path.to).toEqual({ x: 100, y: 50 });
  });
});
