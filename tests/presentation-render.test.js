import { describe, expect, it } from "vitest";
import { renderObject, renderSlide, TEXT_PLACEHOLDER } from "../src/presentation/render.js";
import { createObject, createSlide } from "../src/presentation/model.js";

describe("renderSlide", () => {
  it("is the logical size with the background and z-order from objectOrder", () => {
    const a = createObject("shape", { name: "a" });
    const b = createObject("shape", { name: "b" });
    const slide = createSlide({ objects: [a, b], background: { color: "#112233" } });
    slide.objectOrder.reverse();
    const el = renderSlide(slide, { size: { width: 1024, height: 768 } });
    expect(el.dataset.slideId).toBe(slide.id);
    expect(el.style.width).toBe("1024px");
    expect(el.style.height).toBe("768px");
    expect(el.style.background).toBe("rgb(17, 34, 51)");
    expect([...el.querySelectorAll(".slide-object")].map((o) => o.dataset.objectId)).toEqual([b.id, a.id]);
  });

  it("applies a scale transform only when asked", () => {
    const slide = createSlide();
    expect(renderSlide(slide).style.transform).toBe("");
    expect(renderSlide(slide, { scale: 0.25 }).style.transform).toBe("scale(0.25)");
  });
});

describe("renderObject", () => {
  it("positions in logical px and rotates", () => {
    const o = createObject("shape", { x: 10, y: 20, width: 100, height: 50, rotation: 30 });
    const el = renderObject(o);
    expect(el.dataset.objectId).toBe(o.id);
    expect(el.style.left).toBe("10px");
    expect(el.style.width).toBe("100px");
    expect(el.style.transform).toBe("rotate(30deg)");
    expect(renderObject(createObject("shape")).style.transform).toBe("");
  });

  it("draws each shape as svg", () => {
    const tag = { rect: "rect", roundRect: "rect", ellipse: "ellipse", triangle: "polygon", arrow: "polygon" };
    for (const [shape, expected] of Object.entries(tag)) {
      const svg = renderObject(createObject("shape", { shape })).querySelector("svg");
      expect(svg.firstElementChild.tagName.toLowerCase()).toBe(expected);
    }
    const none = renderObject(createObject("shape", { fill: null, stroke: null })).querySelector("svg > *");
    expect(none.getAttribute("fill")).toBe("none");
    expect(none.getAttribute("stroke")).toBe("none");
  });

  it("draws a line diagonal, flipped when flipV", () => {
    const line = renderObject(createObject("line", { width: 100, height: 40 })).querySelector("line:last-child");
    expect([line.getAttribute("y1"), line.getAttribute("y2")]).toEqual(["0", "40"]);
    const flipped = renderObject(createObject("line", { width: 100, height: 40, flipV: true })).querySelector("line:last-child");
    expect([flipped.getAttribute("y1"), flipped.getAttribute("y2")]).toEqual(["40", "0"]);
    expect(renderObject(createObject("line", { height: 0 })).querySelector("svg")).toBeTruthy();
  });

  it("adds a line hit area only when interactive", () => {
    const o = createObject("line");
    expect(renderObject(o).querySelectorAll("line")).toHaveLength(1);
    expect(renderObject(o, { interactive: true }).querySelectorAll("line")).toHaveLength(2);
  });

  it("renders text through runs with text styling, never as HTML", () => {
    const o = createObject("text", {
      text: { runs: [{ text: "<b>x</b>", marks: { bold: true } }], fontSize: 40, color: "#ff0000", align: "center", valign: "middle" }
    });
    const el = renderObject(o);
    const body = el.querySelector(".slide-text");
    expect(body.textContent).toBe("<b>x</b>");
    expect(body.querySelector("strong")).toBeTruthy();
    expect(body.querySelector("b")).toBeNull();
    expect(body.style.fontSize).toBe("40px");
    expect(body.style.textAlign).toBe("center");
    expect(body.style.justifyContent).toBe("center");
  });

  it("shows a placeholder for empty text objects only when interactive", () => {
    const o = createObject("text");
    expect(renderObject(o).querySelector(".slide-text").dataset.placeholder).toBeUndefined();
    expect(renderObject(o, { interactive: true }).querySelector(".slide-text").dataset.placeholder).toBe(TEXT_PLACEHOLDER);
    const filled = createObject("text", { text: { runs: [{ text: "hi" }] } });
    expect(renderObject(filled, { interactive: true }).querySelector(".slide-text").dataset.placeholder).toBeUndefined();
  });

  it("renders shape text on top of the shape", () => {
    const o = createObject("shape", { text: { runs: [{ text: "label" }] } });
    const el = renderObject(o);
    expect(el.querySelector("svg")).toBeTruthy();
    expect(el.querySelector(".slide-text").textContent).toBe("label");
    expect(renderObject(createObject("shape")).querySelector(".slide-text")).toBeNull();
  });

  it("renders images and link data", () => {
    const o = createObject("image", { src: "data:image/png;base64,AAAA", link: { kind: "url", url: "https://x.test" } });
    const el = renderObject(o);
    expect(el.querySelector("img").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(el.dataset.linkKind).toBe("url");
    expect(el.dataset.href).toBe("https://x.test");
    expect(renderObject(createObject("image")).querySelector("img").hasAttribute("src")).toBe(false);
  });
});
