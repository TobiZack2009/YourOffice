import { describe, expect, it } from "vitest";
import { svgDataUrl } from "../src/export/encode.js";
import { createContext } from "../src/export/context.js";
import { planExport } from "../src/export/plan.js";
import { provideSlideImages, slideSvgInline, slideSvgText } from "../src/export/slide-svg-render.js";
import { exportFixture } from "./export-fixture.js";

function context() {
  const fixture = exportFixture();
  const plan = planExport(fixture.ws, { format: "markdown" });
  return { ...fixture, ctx: createContext(fixture.ws, plan, { document }) };
}

describe("slideSvgText", () => {
  it("is a standalone SVG document of the slide's size with its own stylesheet", () => {
    const { ctx, deck } = context();
    const text = slideSvgText(ctx, deck, "s1");
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const svg = doc.documentElement;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("width")).toBe("1280");
    expect(svg.getAttribute("height")).toBe("720");
    expect(svg.getAttribute("viewBox")).toBe("0 0 1280 720");
    expect(svg.querySelector("style").textContent).toContain(".slide-text");
  });

  it("holds the slide's content in a foreignObject", () => {
    const { ctx, deck } = context();
    const doc = new DOMParser().parseFromString(slideSvgText(ctx, deck, "s1"), "image/svg+xml");
    const text = doc.querySelector("foreignObject .slide-text");
    expect(text.textContent).toBe("Welcome");
    expect(text.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  });

  it("is well-formed even when the text holds characters XML cannot carry", () => {
    const { ctx, ws, deck } = context();
    ws.dispatch("insertObject", {
      pageId: deck,
      slideId: "s2",
      object: { id: "t2", type: "text", x: 0, y: 0, width: 200, height: 50, rotation: 0, text: { runs: [{ text: "a\u0001b <&> c" }], fontSize: 20, color: "#000", align: "left", valign: "top" } }
    });
    const text = slideSvgText(ctx, deck, "s2");
    expect(text).not.toContain("\u0001");
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector(".slide-text").textContent).toBe("ab <&> c");
  });

  it("is null for a slide that does not exist", () => {
    const { ctx, deck } = context();
    expect(slideSvgText(ctx, deck, "nope")).toBeNull();
  });
});

describe("slideSvgInline", () => {
  it("leaves the stylesheet to the page", () => {
    const { ctx, deck } = context();
    const html = slideSvgInline(ctx, deck, "s1");
    expect(html.startsWith("<svg")).toBe(true);
    expect(html).not.toContain("<style>");
    expect(html).toContain("Welcome");
  });
});

describe("provideSlideImages", () => {
  it("hands out SVG data addresses, drawn once each", () => {
    const { ctx, deck } = context();
    provideSlideImages(ctx);
    const url = ctx.slideImage(deck, "s1");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(url).toBe(svgDataUrl(slideSvgText(ctx, deck, "s1")));
    expect(ctx.slideImage(deck, "s1")).toBe(url);
    expect(ctx.slideImage(deck, "s2")).not.toBe(url);
  });
});
