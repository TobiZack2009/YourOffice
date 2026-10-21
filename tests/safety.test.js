import { describe, expect, it } from "vitest";
import { createWorkspace, exportWorkspaceJSON, importWorkspaceJSON } from "../src/domain/index.js";
import { ensureDocumentContent, validateBlock } from "../src/document/model.js";
import { ensureSheetContent } from "../src/calc/model.js";
import { ensurePresentationContent, validateObject } from "../src/presentation/model.js";
import { renderRuns } from "../src/document/render.js";
import { parseInlineRuns } from "../src/app/inline.js";
import { CommandError, WorkspaceFormatError } from "../src/core/errors.js";

function workspaceWithDocument(runs) {
  const ws = createWorkspace({ title: "Safety" });
  ws.dispatch("createPage", { type: "document", title: "Doc" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "x" }] } });
  const json = JSON.parse(exportWorkspaceJSON(ws));
  const content = json.pages[pageId].content;
  content.blocks[content.blockOrder[0]].runs = runs;
  return { json, pageId };
}

describe("unsafe links", () => {
  it("rejects an imported document whose link mark runs script", () => {
    const { json } = workspaceWithDocument([{ text: "click", marks: { link: "javascript:alert(1)" } }]);
    expect(() => importWorkspaceJSON(JSON.stringify(json))).toThrow(WorkspaceFormatError);
    expect(() => importWorkspaceJSON(JSON.stringify(json))).toThrow(/safe address/);
  });

  it("accepts safe links", () => {
    const { json } = workspaceWithDocument([{ text: "ok", marks: { link: "https://a.test" } }]);
    expect(() => importWorkspaceJSON(JSON.stringify(json))).not.toThrow();
  });

  it("validators flag unsafe block and slide-object links", () => {
    const block = { id: "b", type: "paragraph", runs: [{ text: "x", marks: { link: "data:text/html,x" } }] };
    expect(validateBlock(block).join()).toMatch(/safe address/);
    const object = { id: "o", type: "text", x: 0, y: 0, width: 10, height: 10, link: { kind: "url", url: "javascript:1" } };
    expect(validateObject(object).join()).toMatch(/safe address/);
  });

  it("the renderer never emits an unsafe href", () => {
    const fragment = renderRuns([{ text: "bad", marks: { link: "javascript:alert(1)" } }, { text: "good", marks: { link: "https://a.test" } }]);
    const host = document.createElement("p");
    host.appendChild(fragment);
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://a.test"]);
    expect(host.textContent).toBe("badgood");
  });

  it("reading runs back from the DOM drops an unsafe href", () => {
    const host = document.createElement("p");
    host.innerHTML = '<a href="javascript:alert(1)">bad</a>';
    expect(parseInlineRuns(host)).toEqual([{ text: "bad" }]);
  });
});

describe("content validation at the boundaries", () => {
  it("setPageContent rejects content that does not fit the page type", () => {
    const ws = createWorkspace({ title: "T" });
    ws.dispatch("createPage", { type: "sheet" });
    const pageId = ws.getChildren(null)[0];
    expect(() => ws.dispatch("setPageContent", { pageId, content: { blocks: {} } })).toThrow(CommandError);
  });

  it("import rejects malformed page content", () => {
    const ws = createWorkspace({ title: "T" });
    ws.dispatch("createPage", { type: "presentation" });
    const json = JSON.parse(exportWorkspaceJSON(ws));
    const pageId = Object.keys(json.pages)[0];
    json.pages[pageId].content = { slides: [] };
    expect(() => importWorkspaceJSON(JSON.stringify(json))).toThrow(WorkspaceFormatError);
  });

  it("import accepts a page that has no content yet", () => {
    const ws = createWorkspace({ title: "T" });
    ws.dispatch("createPage", { type: "document" });
    expect(() => importWorkspaceJSON(exportWorkspaceJSON(ws))).not.toThrow();
  });

  it("export refuses to write a corrupt workspace", () => {
    const ws = createWorkspace({ title: "T" });
    ws.dispatch("createPage", { type: "document" });
    const pageId = ws.getChildren(null)[0];
    ws._data.pages[pageId].content = { oops: true };
    expect(() => exportWorkspaceJSON(ws)).toThrow(/corrupt/);
  });
});

describe("ensure*Content", () => {
  const page = (content) => ({ id: "p", type: "document", title: "", createdAt: "", modifiedAt: "", content });

  it("initialises content only when it is absent", () => {
    for (const [ensure, key] of [[ensureDocumentContent, "blockOrder"], [ensureSheetContent, "tableOrder"], [ensurePresentationContent, "slideOrder"]]) {
      expect(ensure(page(undefined))[key]).toEqual([]);
      expect(ensure(page(null))[key]).toEqual([]);
    }
  });

  it("throws corruptContent instead of replacing malformed content", () => {
    for (const ensure of [ensureDocumentContent, ensureSheetContent, ensurePresentationContent]) {
      const bad = page({ junk: 1 });
      expect(() => ensure(bad)).toThrow(CommandError);
      try {
        ensure(bad);
      } catch (error) {
        expect(error.reason).toBe("corruptContent");
      }
      expect(bad.content).toEqual({ junk: 1 });
    }
  });
});
