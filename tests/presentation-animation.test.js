import { describe, expect, it } from "vitest";
import {
  PREVIEW_STEP_PAUSE,
  effectKeyframes,
  initiallyHidden,
  planPreview,
  planTimeline,
  slideInOffset
} from "../src/presentation/animation.js";
import { createAnimation, createObject, createSlide } from "../src/presentation/model.js";

const SIZE = { width: 1280, height: 720 };

function slideWith(specs) {
  const shape = createObject("shape", { x: 100, y: 200, width: 300, height: 100 });
  const slide = createSlide({ objects: [shape] });
  for (const spec of specs) {
    const animation = createAnimation({ objectId: shape.id, ...spec });
    slide.animations[animation.id] = animation;
    slide.animationOrder.push(animation.id);
  }
  return { slide, shape };
}

describe("planTimeline", () => {
  it("is empty without animations and tolerates old slides", () => {
    expect(planTimeline(createSlide())).toEqual([]);
    expect(planTimeline({})).toEqual([]);
  });

  it("starts a new step on each click; the first animation opens step 0", () => {
    const { slide } = slideWith([{ trigger: "click" }, { trigger: "click" }, { trigger: "click" }]);
    expect(planTimeline(slide).map((e) => e.step)).toEqual([0, 1, 2]);
  });

  it("anchors with-previous to the previous anchor and after-previous to the previous end", () => {
    const { slide } = slideWith([
      { trigger: "click", duration: 500, delay: 100 },
      { trigger: "with", duration: 300, delay: 50 },
      { trigger: "after", duration: 200, delay: 0 },
      { trigger: "after", duration: 100, delay: 25 }
    ]);
    const t = planTimeline(slide);
    expect(t[0]).toMatchObject({ step: 0, anchor: 0, start: 100, end: 600 });
    expect(t[1]).toMatchObject({ step: 0, anchor: 0, start: 50, end: 350 });
    // "after" waits for the previous animation (the 300 ms one) to finish.
    expect(t[2]).toMatchObject({ anchor: 350, start: 350, end: 550 });
    expect(t[3]).toMatchObject({ anchor: 550, start: 575, end: 675 });
  });

  it("treats a leading with/after as step 0 at time zero", () => {
    const { slide } = slideWith([{ trigger: "after", delay: 200, duration: 100 }, { trigger: "click" }]);
    const t = planTimeline(slide);
    expect(t[0]).toMatchObject({ step: 0, anchor: 0, start: 200 });
    expect(t[1].step).toBe(1);
  });

  it("with-previous after an after-previous shares that animation's anchor", () => {
    const { slide } = slideWith([{ trigger: "click", duration: 400 }, { trigger: "after", duration: 100 }, { trigger: "with" }]);
    const t = planTimeline(slide);
    expect(t[2].anchor).toBe(t[1].anchor);
  });
});

describe("planPreview", () => {
  it("runs steps one after another with a pause and reports the total", () => {
    const { slide } = slideWith([
      { trigger: "click", duration: 500 },
      { trigger: "with", duration: 800 },
      { trigger: "click", duration: 300, delay: 100 }
    ]);
    const { items, total } = planPreview(slide);
    expect(items.map((i) => i.at)).toEqual([0, 0, 800 + PREVIEW_STEP_PAUSE + 100]);
    expect(total).toBe(800 + PREVIEW_STEP_PAUSE + 400);
  });

  it("is empty for no animations", () => {
    expect(planPreview(createSlide())).toEqual({ items: [], total: 0 });
  });
});

describe("initiallyHidden", () => {
  it("hides objects with an entrance effect only", () => {
    const a = createObject("shape");
    const b = createObject("shape");
    const c = createObject("shape");
    const slide = createSlide({ objects: [a, b, c] });
    for (const [objectId, effect] of [[a.id, "fade-in"], [b.id, "motion"], [c.id, "slide-in"]]) {
      const anim = createAnimation({ objectId, effect });
      slide.animations[anim.id] = anim;
      slide.animationOrder.push(anim.id);
    }
    expect([...initiallyHidden(slide)].sort()).toEqual([a.id, c.id].sort());
  });
});

describe("slideInOffset", () => {
  const object = { x: 100, y: 200, width: 300, height: 100, rotation: 0 };
  it("parks the object just past the edge it enters from", () => {
    expect(slideInOffset(object, "left", SIZE)).toEqual({ x: -400, y: 0 });
    expect(slideInOffset(object, "right", SIZE)).toEqual({ x: 1180, y: 0 });
    expect(slideInOffset(object, "up", SIZE)).toEqual({ x: 0, y: -300 });
    expect(slideInOffset(object, "down", SIZE)).toEqual({ x: 0, y: 520 });
  });

  it("accounts for rotation through the rotated bounds", () => {
    const rotated = { x: 100, y: 200, width: 300, height: 100, rotation: 90 };
    // Centre (250, 250); rotated bounds are 100 wide, 300 tall: x 200..300.
    expect(slideInOffset(rotated, "left", SIZE)).toEqual({ x: -300, y: 0 });
  });
});

describe("effectKeyframes", () => {
  const object = { x: 100, y: 200, width: 300, height: 100, rotation: 0 };
  it("fades and appears with opacity", () => {
    const fade = createAnimation({ objectId: "o", effect: "fade-in" });
    expect(effectKeyframes(fade, object, SIZE)).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(effectKeyframes(createAnimation({ objectId: "o", effect: "appear" }), object, SIZE)).toHaveLength(2);
  });

  it("slides with the individual translate property, ending at rest", () => {
    const slide = createAnimation({ objectId: "o", effect: "slide-in", direction: "right" });
    expect(effectKeyframes(slide, object, SIZE)).toEqual([{ translate: "1180px 0px" }, { translate: "0px 0px" }]);
  });

  it("moves between the two path offsets", () => {
    const motion = createAnimation({ objectId: "o", effect: "motion", path: { from: { x: 0, y: 0 }, to: { x: 50, y: -20 } } });
    expect(effectKeyframes(motion, object, SIZE)).toEqual([{ translate: "0px 0px" }, { translate: "50px -20px" }]);
  });
});
