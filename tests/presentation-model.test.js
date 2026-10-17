import { describe, expect, it } from "vitest";
import {
  createObject,
  createPresentationContent,
  createSlide,
  ensurePresentationContent,
  isColor,
  validateObject,
  validatePresentationContent,
  validateSlide
} from "../src/presentation/model.js";
import { LAYOUTS, getLayout } from "../src/presentation/layouts.js";

describe("createObject", () => {
  it("gives every object a stable prefixed id", () => {
    const a = createObject("shape");
    const b = createObject("shape");
    expect(a.id).toMatch(/^obj_/);
    expect(a.id).not.toBe(b.id);
  });

  it("applies per-type defaults", () => {
    const shape = createObject("shape", { shape: "ellipse" });
    expect(shape.shape).toBe("ellipse");
    expect(shape.fill).toBeTruthy();
    expect(shape.stroke).toBeTruthy();

    const text = createObject("text");
    expect(text.text).toMatchObject({ runs: [], fontSize: 32, align: "left" });

    const line = createObject("line");
    expect(line.height).toBe(0);
    expect(line.flipV).toBe(false);

    expect(createObject("image", { src: "data:image/png;base64,AAAA" }).src).toContain("data:image/png");
  });

  it("deep-copies its input", () => {
    const runs = [{ text: "hi" }];
    const object = createObject("text", { text: { runs } });
    runs[0].text = "changed";
    expect(object.text.runs[0].text).toBe("hi");
  });
});

describe("validateObject", () => {
  it("accepts well-formed objects of every type", () => {
    for (const type of ["text", "shape", "line", "image"]) {
      expect(validateObject(createObject(type))).toEqual([]);
    }
  });

  it("rejects bad geometry, colours, shapes and types", () => {
    expect(validateObject(createObject("shape", { width: 0 }))).not.toEqual([]);
    expect(validateObject(createObject("shape", { x: Infinity }))).not.toEqual([]);
    expect(validateObject(createObject("shape", { fill: "red" }))).not.toEqual([]);
    expect(validateObject(createObject("shape", { shape: "star" }))).not.toEqual([]);
    expect(validateObject({ ...createObject("shape"), type: "chart" })).not.toEqual([]);
    expect(validateObject("nope")).not.toEqual([]);
  });

  it("allows a flat line but not a flat rectangle", () => {
    expect(validateObject(createObject("line", { height: 0 }))).toEqual([]);
    expect(validateObject(createObject("shape", { height: 0 }))).not.toEqual([]);
  });

  it("validates text bodies, links and images", () => {
    expect(validateObject(createObject("text", { text: { fontSize: 2 } }))).not.toEqual([]);
    expect(validateObject(createObject("text", { text: { runs: [{ text: "" }] } }))).not.toEqual([]);
    expect(validateObject({ ...createObject("shape"), link: { kind: "url" } })).not.toEqual([]);
    expect(validateObject({ ...createObject("shape"), link: { kind: "url", url: "https://x.test" } })).toEqual([]);
    expect(validateObject(createObject("image", { src: "javascript:alert(1)" }))).not.toEqual([]);
    expect(validateObject({ ...createObject("line"), text: { runs: [] } })).not.toEqual([]);
  });
});

describe("slides and content", () => {
  it("creates a valid empty slide and content", () => {
    const content = createPresentationContent();
    expect(content.size).toEqual({ width: 1280, height: 720 });
    const slide = createSlide();
    content.slides[slide.id] = slide;
    content.slideOrder.push(slide.id);
    expect(slide.id).toMatch(/^slide_/);
    expect(validateSlide(slide)).toEqual([]);
    expect(validatePresentationContent(content)).toEqual([]);
  });

  it("keeps identity apart from z-order", () => {
    const a = createObject("shape");
    const b = createObject("shape");
    const slide = createSlide({ objects: [a, b] });
    expect(slide.objectOrder).toEqual([a.id, b.id]);
    slide.objectOrder.reverse();
    expect(slide.objects[a.id].id).toBe(a.id);
    expect(validateSlide(slide)).toEqual([]);
  });

  it("reports structural problems", () => {
    const content = createPresentationContent();
    const slide = createSlide({ objects: [createObject("shape")] });
    content.slides[slide.id] = slide;
    expect(validatePresentationContent(content).join()).toMatch(/not in slideOrder/);
    content.slideOrder.push(slide.id, slide.id);
    expect(validatePresentationContent(content).join()).toMatch(/twice/);
    content.slideOrder = [slide.id, "slide_ghost"];
    expect(validatePresentationContent(content).join()).toMatch(/missing slide/);
    content.slideOrder = [slide.id];
    slide.objectOrder = ["obj_ghost"];
    expect(validatePresentationContent(content).join()).toMatch(/missing object/);
    content.size = { width: 10, height: 720 };
    expect(validatePresentationContent(content).join()).toMatch(/size\.width/);
  });

  it("ensurePresentationContent is idempotent and repairs gaps", () => {
    const page = { id: "pres_1", type: "presentation", title: "", createdAt: "", modifiedAt: "" };
    const first = ensurePresentationContent(page);
    expect(ensurePresentationContent(page)).toBe(first);
    first.size = { width: 5, height: 5 };
    expect(ensurePresentationContent(page).size).toEqual({ width: 1280, height: 720 });
  });
});

describe("layouts", () => {
  it("pre-places only text objects, in fractions of the slide size", () => {
    expect(LAYOUTS.map((l) => l.id)).toEqual(["title", "titleContent", "twoColumns", "blank"]);
    const wide = getLayout("titleContent").objects({ width: 1280, height: 720 });
    const small = getLayout("titleContent").objects({ width: 640, height: 360 });
    expect(wide.every((o) => o.type === "text" && validateObject(o).length === 0)).toBe(true);
    expect(small[0].width).toBe(wide[0].width / 2);
    expect(small[0].text.fontSize).toBe(wide[0].text.fontSize / 2);
    expect(getLayout("blank").objects({ width: 1280, height: 720 })).toEqual([]);
    expect(getLayout("twoColumns").objects({ width: 1280, height: 720 })).toHaveLength(3);
  });
});

describe("isColor", () => {
  it("accepts hex colours only", () => {
    expect(isColor("#fff")).toBe(true);
    expect(isColor("#1d6fdc")).toBe(true);
    expect(isColor("red")).toBe(false);
    expect(isColor("url(x)")).toBe(false);
  });
});
