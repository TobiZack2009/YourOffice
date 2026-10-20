import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import {
  breadcrumb,
  pageContent,
  pageExists,
  pageInfo,
  pageList,
  pageTitle,
  pageTree,
  pageType
} from "../src/workspace/selectors.js";

function build() {
  const ws = createWorkspace({ title: "W" });
  const { pageId: top } = ws.dispatch("createPage", { type: "document", title: "Top" });
  const { pageId: child } = ws.dispatch("createPage", { type: "sheet", title: "Child", parentId: top });
  const { pageId: leaf } = ws.dispatch("createPage", { type: "presentation", title: "Leaf", parentId: child });
  const { pageId: other } = ws.dispatch("createPage", { type: "document", title: "Other" });
  return { ws, top, child, leaf, other };
}

describe("page selectors", () => {
  it("answer small questions without cloning the page", () => {
    const { ws, top, child } = build();
    expect(pageExists(ws, top)).toBe(true);
    expect(pageExists(ws, "nope")).toBe(false);
    expect(pageExists(ws, null)).toBe(false);
    expect(pageTitle(ws, child)).toBe("Child");
    expect(pageTitle(ws, "nope")).toBeUndefined();
    expect(pageType(ws, child)).toBe("sheet");
    expect(pageInfo(ws, top)).toEqual({ id: top, title: "Top", type: "document" });
    expect(pageInfo(ws, undefined)).toBeUndefined();
  });

  it("returns live content, and undefined while a page has none", () => {
    const { ws, top } = build();
    expect(pageContent(ws, top)).toBeUndefined();
    ws.dispatch("insertBlock", { pageId: top, block: { type: "paragraph", runs: [{ text: "x" }] } });
    expect(pageContent(ws, top)).toBe(ws.data.pages[top].content);
    expect(pageContent(ws, "nope")).toBeUndefined();
  });

  it("lists pages as id, title and type only", () => {
    const { ws } = build();
    const list = pageList(ws);
    expect(list).toHaveLength(4);
    for (const entry of list) expect(Object.keys(entry).sort()).toEqual(["id", "title", "type"]);
  });

  it("builds the breadcrumb from the root down", () => {
    const { ws, top, child, leaf } = build();
    expect(breadcrumb(ws, leaf).map((p) => p.id)).toEqual([top, child, leaf]);
    expect(breadcrumb(ws, top).map((p) => p.title)).toEqual(["Top"]);
    expect(breadcrumb(ws, "nope")).toEqual([]);
    expect(breadcrumb(ws, null)).toEqual([]);
  });

  it("builds the page tree in sidebar order", () => {
    const { ws, top, child, leaf, other } = build();
    const tree = pageTree(ws);
    expect(tree.map((n) => n.id)).toEqual([top, other]);
    expect(tree[0].children.map((n) => n.id)).toEqual([child]);
    expect(tree[0].children[0].children.map((n) => n.id)).toEqual([leaf]);
    expect(tree[1].children).toEqual([]);
  });
});
