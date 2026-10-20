import { describe, expect, it } from "vitest";
import {
  hasTransition,
  lastStep,
  nextPosition,
  previousPosition,
  settledAt,
  stepEntries,
  stepLength,
  transitionBetween,
  transitionKeyframes
} from "../src/presentation/slideshow.js";

/** @param {Record<string, any>[]} list */
function slideWith(list) {
  const animations = {};
  const animationOrder = [];
  list.forEach((fields, i) => {
    const id = `a${i}`;
    animations[id] = { id, trigger: "click", delay: 0, duration: 500, ...fields };
    animationOrder.push(id);
  });
  return { animations, animationOrder };
}

describe("steps", () => {
  const slide = slideWith([
    { objectId: "o1", effect: "fade-in" },
    { objectId: "o2", effect: "appear", trigger: "with", duration: 0 },
    { objectId: "o3", effect: "fade-in" },
    { objectId: "o4", effect: "fade-in", trigger: "after", delay: 100 }
  ]);

  it("counts click steps from zero and reports -1 without animations", () => {
    expect(lastStep(slide)).toBe(1);
    expect(lastStep(slideWith([]))).toBe(-1);
  });

  it("groups entries by step and measures how long a step runs", () => {
    expect(stepEntries(slide, 0).map((e) => e.id)).toEqual(["a0", "a1"]);
    expect(stepEntries(slide, 1).map((e) => e.id)).toEqual(["a2", "a3"]);
    expect(stepLength(stepEntries(slide, 0))).toBe(500);
    expect(stepLength(stepEntries(slide, 1))).toBe(500 + 100 + 500);
    expect(stepLength([])).toBe(0);
  });
});

describe("settledAt", () => {
  const slide = slideWith([
    { objectId: "o1", effect: "fade-in" },
    { objectId: "o2", effect: "slide-in", direction: "left" },
    { objectId: "o3", effect: "motion", path: { from: { x: 0, y: 0 }, to: { x: 40, y: -10 } } }
  ]);

  it("hides entrance objects until their step has played", () => {
    expect([...settledAt(slide, -1).hidden].sort()).toEqual(["o1", "o2"]);
    expect([...settledAt(slide, 0).hidden]).toEqual(["o2"]);
    expect(settledAt(slide, 1).hidden.size).toBe(0);
  });

  it("parks a motion at its end once played, nowhere before", () => {
    expect(settledAt(slide, 1).translate.size).toBe(0);
    expect(settledAt(slide, 2).translate.get("o3")).toEqual({ x: 40, y: -10 });
  });
});

describe("moving through a show", () => {
  it("plays remaining steps before leaving the slide", () => {
    expect(nextPosition(3, { index: 0, step: -1 }, 1)).toEqual({ action: "step", position: { index: 0, step: 0 } });
    expect(nextPosition(3, { index: 0, step: 0 }, 1)).toEqual({ action: "step", position: { index: 0, step: 1 } });
    expect(nextPosition(3, { index: 0, step: 1 }, 1)).toEqual({ action: "slide", position: { index: 1, step: -1 } });
  });

  it("stops at the end of the last slide", () => {
    expect(nextPosition(2, { index: 1, step: -1 }, -1)).toEqual({ action: "none", position: { index: 1, step: -1 } });
    expect(nextPosition(2, { index: 1, step: 1 }, 1).action).toBe("none");
  });

  it("goes back one click step, then to the previous slide fully played", () => {
    expect(previousPosition({ index: 2, step: 2 }, 1)).toEqual({ action: "settle", position: { index: 2, step: 1 } });
    // Step 0 plays on its own, so going back from it leaves the slide.
    expect(previousPosition({ index: 2, step: 0 }, 3)).toEqual({ action: "slide", position: { index: 1, step: 3 } });
    expect(previousPosition({ index: 2, step: -1 }, -1)).toEqual({ action: "slide", position: { index: 1, step: -1 } });
    expect(previousPosition({ index: 0, step: 0 }, -1).action).toBe("none");
  });
});

describe("transitions", () => {
  const fade = { style: "fade", direction: "left", duration: 400 };
  const wipe = { style: "wipe", direction: "left", duration: 300 };

  it("uses the incoming slide's transition going forward", () => {
    expect(transitionBetween({ transition: wipe }, { transition: fade }, true)).toEqual(fade);
  });

  it("reuses the outgoing slide's transition the other way round going back", () => {
    expect(transitionBetween({ transition: wipe }, { transition: fade }, false)).toEqual({ ...wipe, direction: "right" });
    expect(transitionBetween({ transition: { ...wipe, direction: "up" } }, { transition: fade }, false).direction).toBe("down");
  });

  it("fades with opacity and wipes with a clip that opens from the chosen side", () => {
    expect(transitionKeyframes(fade)).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(transitionKeyframes(wipe)[0]).toEqual({ clipPath: "inset(0 100% 0 0)" });
    expect(transitionKeyframes({ ...wipe, direction: "down" })[0]).toEqual({ clipPath: "inset(100% 0 0 0)" });
    expect(transitionKeyframes({ style: "none", direction: "left" })).toEqual([]);
  });

  it("has nothing to play for none or a zero duration", () => {
    expect(hasTransition(fade)).toBe(true);
    expect(hasTransition({ style: "none", duration: 400 })).toBe(false);
    expect(hasTransition({ style: "fade", duration: 0 })).toBe(false);
  });
});
