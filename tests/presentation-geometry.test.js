import { describe, expect, it } from "vitest";
import {
  SIZE_PRESETS,
  fitScale,
  normalizeAngle,
  objectsInMarquee,
  planSlideReorder,
  rectCorners,
  rectFromPoints,
  resizeRect,
  rotatedBounds,
  rotationFrom,
  scaleObject,
  snapMove,
  unionBounds
} from "../src/presentation/geometry.js";
import { createObject } from "../src/presentation/model.js";

const close = (actual, expected, digits = 1) => expect(actual).toBeCloseTo(expected, digits);

describe("rotatedBounds", () => {
  it("is the rect itself without rotation", () => {
    expect(rotatedBounds({ x: 10, y: 20, width: 100, height: 50, rotation: 0 })).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("swaps width and height at 90 degrees, about the centre", () => {
    const b = rotatedBounds({ x: 0, y: 0, width: 100, height: 40, rotation: 90 });
    close(b.width, 40);
    close(b.height, 100);
    close(b.x, 30);
    close(b.y, -30);
  });

  it("grows at 45 degrees", () => {
    const b = rotatedBounds({ x: 0, y: 0, width: 100, height: 100, rotation: 45 });
    close(b.width, 141.4);
    expect(rectCorners({ x: 0, y: 0, width: 10, height: 10 })).toHaveLength(4);
  });
});

describe("unionBounds / rectFromPoints", () => {
  it("unions rects and normalises drag direction", () => {
    expect(unionBounds([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }])).toEqual({
      x: 0, y: 0, width: 30, height: 15
    });
    expect(unionBounds([])).toBeNull();
    expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 60 })).toEqual({ x: 10, y: 40, width: 40, height: 20 });
  });
});

describe("resizeRect", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it("keeps the opposite edge fixed (unrotated)", () => {
    expect(resizeRect(rect, 0, "se", { x: 50, y: 20 })).toEqual({ x: 100, y: 100, width: 250, height: 120 });
    expect(resizeRect(rect, 0, "nw", { x: 20, y: 10 })).toEqual({ x: 120, y: 110, width: 180, height: 90 });
    expect(resizeRect(rect, 0, "e", { x: 30, y: 99 })).toEqual({ x: 100, y: 100, width: 230, height: 100 });
    expect(resizeRect(rect, 0, "n", { x: 99, y: -40 })).toEqual({ x: 100, y: 60, width: 200, height: 140 });
  });

  it("clamps to a minimum size without moving the fixed edge", () => {
    const r = resizeRect(rect, 0, "w", { x: 500, y: 0 }, { minWidth: 10 });
    expect(r.width).toBe(10);
    expect(r.x + r.width).toBe(300);
  });

  it("works in the rotated frame and keeps the opposite corner on the slide", () => {
    const rotated = { x: 100, y: 100, width: 200, height: 100 };
    const before = rectCorners({ ...rotated, rotation: 90 });
    // Rotated 90deg clockwise: local +x points down the slide.
    const next = resizeRect(rotated, 90, "e", { x: 0, y: 40 });
    close(next.width, 240);
    const after = rectCorners({ ...next, rotation: 90 });
    // The west edge (corners 0 and 3) has not moved.
    close(after[0].x, before[0].x);
    close(after[0].y, before[0].y);
    close(after[3].x, before[3].x);
    close(after[3].y, before[3].y);
  });

  it("keeps aspect ratio on corners and edges", () => {
    const r = resizeRect(rect, 0, "se", { x: 100, y: 0 }, { keepAspect: true });
    close(r.width / r.height, 2);
    expect(r.width).toBe(300);
    const e = resizeRect(rect, 0, "e", { x: 100, y: 0 }, { keepAspect: true });
    close(e.width / e.height, 2);
    close(e.y + e.height / 2, 150);
  });

  it("resizes from the centre", () => {
    expect(resizeRect(rect, 0, "e", { x: 20, y: 0 }, { fromCenter: true })).toEqual({ x: 80, y: 100, width: 240, height: 100 });
  });
});

describe("rotation", () => {
  it("measures from straight above the centre", () => {
    const c = { x: 100, y: 100 };
    close(rotationFrom(c, { x: 100, y: 0 }), 0);
    close(rotationFrom(c, { x: 200, y: 100 }), 90);
    close(rotationFrom(c, { x: 100, y: 200 }), 180);
    close(rotationFrom(c, { x: 0, y: 100 }), 270);
  });

  it("snaps to 15 degrees and normalises angles", () => {
    expect(rotationFrom({ x: 0, y: 0 }, { x: 100, y: -90 }, { snap: true })).toBe(45);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(725)).toBe(5);
  });
});

describe("snapMove", () => {
  const slide = { width: 1280, height: 720 };

  it("snaps to the slide edges and centre within the threshold", () => {
    const edge = snapMove({ x: 4, y: 100, width: 100, height: 50 }, [], slide);
    expect(edge.dx).toBe(-4);
    expect(edge.guides.some((g) => g.axis === "x" && g.position === 0)).toBe(true);

    const centred = snapMove({ x: 592, y: 335, width: 100, height: 50 }, [], slide);
    expect(centred.dx).toBe(-2);
    expect(centred.dy).toBe(0);
    expect(centred.guides.some((g) => g.axis === "x" && g.position === 640)).toBe(true);
    expect(centred.guides.some((g) => g.axis === "y" && g.position === 360)).toBe(true);
  });

  it("snaps to other objects' edges and centres", () => {
    const other = { x: 300, y: 200, width: 100, height: 100 };
    const r = snapMove({ x: 395, y: 500, width: 80, height: 40 }, [other], slide);
    expect(r.dx).toBe(5);
    const guide = r.guides.find((g) => g.axis === "x" && g.position === 400);
    expect(guide).toBeTruthy();
    expect(guide.start).toBeLessThanOrEqual(200);
    expect(guide.end).toBeGreaterThanOrEqual(540);
  });

  it("does not snap outside the threshold and snaps to a grid when enabled", () => {
    expect(snapMove({ x: 50, y: 50, width: 10, height: 10 }, [], slide)).toMatchObject({ dx: 0, dy: 0, guides: [] });
    const grid = snapMove({ x: 52, y: 47, width: 11, height: 13 }, [], slide, { grid: 10 });
    expect([grid.dx, grid.dy]).toEqual([-2, 3]);
    expect(snapMove({ x: 52, y: 47, width: 11, height: 13 }, [], slide, { grid: 0 }).dx).toBe(0);
  });
});

describe("objectsInMarquee", () => {
  it("returns touched ids bottom to top, using rotated bounds", () => {
    const a = createObject("shape", { x: 0, y: 0, width: 100, height: 100 });
    const b = createObject("shape", { x: 300, y: 300, width: 100, height: 100 });
    const c = createObject("shape", { x: 150, y: 0, width: 100, height: 20, rotation: 90 });
    const slide = { objectOrder: [a.id, b.id, c.id], objects: { [a.id]: a, [b.id]: b, [c.id]: c } };
    expect(objectsInMarquee(slide, { x: 90, y: 90, width: 20, height: 20 })).toEqual([a.id]);
    expect(objectsInMarquee(slide, { x: 0, y: 0, width: 500, height: 500 })).toEqual([a.id, b.id, c.id]);
    // c's rotated bounds reach down to y = 50, a straight-up rect would not.
    expect(objectsInMarquee(slide, { x: 190, y: 45, width: 5, height: 5 })).toEqual([c.id]);
    expect(objectsInMarquee(slide, { x: 600, y: 600, width: 5, height: 5 })).toEqual([]);
  });
});

describe("planSlideReorder", () => {
  const order = ["a", "b", "c", "d"];
  it("computes the index in the lifted order", () => {
    expect(planSlideReorder(order, "a", { type: "after", id: "c" })).toEqual({ index: 2 });
    expect(planSlideReorder(order, "d", { type: "before", id: "b" })).toEqual({ index: 1 });
    expect(planSlideReorder(order, "c", { type: "before", id: "a" })).toEqual({ index: 0 });
    expect(planSlideReorder(order, "a", { type: "after", id: "d" })).toEqual({ index: 3 });
  });

  it("returns null for no-ops and bad input", () => {
    expect(planSlideReorder(order, "b", { type: "before", id: "c" })).toBeNull();
    expect(planSlideReorder(order, "b", { type: "after", id: "a" })).toBeNull();
    expect(planSlideReorder(order, "b", { type: "after", id: "b" })).toBeNull();
    expect(planSlideReorder(order, "x", { type: "after", id: "a" })).toBeNull();
    expect(planSlideReorder(order, "a", { type: "after", id: "x" })).toBeNull();
  });
});

describe("fitScale / scaleObject / presets", () => {
  it("fits a slide in an area", () => {
    expect(fitScale({ width: 640, height: 720 }, { width: 1280, height: 720 })).toBe(0.5);
    expect(fitScale({ width: 2560, height: 360 }, { width: 1280, height: 720 })).toBe(0.5);
    expect(fitScale({ width: 0, height: 0 }, { width: 1280, height: 720 })).toBe(1);
  });

  it("scales geometry per axis and fonts by the smaller ratio, without mutating", () => {
    const text = createObject("text", { x: 100, y: 60, width: 400, height: 80, rotation: 30, text: { fontSize: 40 } });
    const scaled = scaleObject(text, 0.5, 2);
    expect(scaled).toMatchObject({ x: 50, y: 120, width: 200, height: 160, rotation: 30 });
    expect(scaled.text.fontSize).toBe(20);
    expect(text.x).toBe(100);
    expect(scaled.id).toBe(text.id);
  });

  it("ships the three presets", () => {
    expect(SIZE_PRESETS.map((p) => [p.width, p.height])).toEqual([[1280, 720], [1024, 768], [1280, 800]]);
  });
});
