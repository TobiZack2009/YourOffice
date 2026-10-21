import { createWorkspace } from "../src/domain/index.js";
import { createObject, createTextBody } from "../src/presentation/model.js";

/**
 * A workspace that exercises the exporters.
 *
 *   Notes (document)   heading, marked text, a link to Other, a list with a nested paragraph, a code
 *                      block, an image, a page link, a divider, embeds of a table and a slide, an
 *                      expression
 *     Child (document) one paragraph
 *   Other (document)   one paragraph
 *   Data (sheet)       table "Costs": A1 = 5, A2 = 7, B1 = A1 * 2
 *   Deck (presentation) two slides, the first with a text object
 */
export function exportFixture() {
  const ws = createWorkspace({ title: "My Workspace" });
  const page = (type, title, parentId) => ws.dispatch("createPage", { type, title, ...(parentId ? { parentId } : {}) }).pageId;
  const notes = page("document", "Notes");
  const child = page("document", "Child", notes);
  const other = page("document", "Other");
  const data = page("sheet", "Data");
  const deck = page("presentation", "Deck");

  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 5 } });
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 1, cell: { value: 7 } });
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 1, row: 0, cell: { formula: "=A1*2" } });
  ws.dispatch("createSection", { pageId: data, name: "CostsSec", locator: { tableId: costs }, sectionId: "sec_costs" });

  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s1" });
  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s2" });
  ws.dispatch("insertObject", {
    pageId: deck,
    slideId: "s1",
    object: createObject("text", { id: "t1", x: 80, y: 80, width: 600, height: 100, text: createTextBody({ runs: [{ text: "Welcome" }] }) })
  });
  ws.dispatch("createSection", { pageId: deck, name: "First", locator: { slideId: "s1" }, sectionId: "sec_s1" });

  const { assetId } = ws.dispatch("addAsset", { mimeType: "image/png", name: "dot.png", data: "iVBORw0KGgo=" });

  const insert = (pageId, id, block, extra = {}) => ws.dispatch("insertBlock", { pageId, newBlockId: id, block, ...extra });
  insert(notes, "h1", { type: "heading", level: 1, runs: [{ text: "Intro" }] });
  insert(notes, "p1", {
    type: "paragraph",
    runs: [
      { text: "Hello " },
      { text: "world", marks: { bold: true } },
      { text: " and " },
      { text: "Other", marks: { link: `#${other}` } },
      { text: " site", marks: { link: "https://example.com/a(b)" } }
    ]
  });
  insert(notes, "list", {
    type: "list",
    ordered: false,
    items: [
      { id: "i1", runs: [{ text: "first" }] },
      { id: "i2", runs: [{ text: "second" }] }
    ]
  });
  insert(notes, "nested", { type: "paragraph", runs: [{ text: "under second" }] }, { parent: { blockId: "list", itemId: "i2" } });
  insert(notes, "code", { type: "code", language: "js", text: "const a = 1;\n// ``` fenced" });
  insert(notes, "img", { type: "image", assetId, alt: "A dot" });
  insert(notes, "link", { type: "pageLink", pageId: other });
  insert(notes, "rule", { type: "divider" });
  ws.dispatch("insertReference", { pageId: notes, kind: "embed", sectionId: "sec_costs", instanceId: "embed_table" });
  ws.dispatch("insertReference", { pageId: notes, kind: "embed", sectionId: "sec_s1", instanceId: "embed_slide" });
  ws.dispatch("insertReference", { pageId: notes, kind: "expression", expression: "Data!Costs!A1 + 1", instanceId: "expr" });

  insert(child, "c1", { type: "paragraph", runs: [{ text: "child text" }] });
  insert(other, "o1", { type: "paragraph", runs: [{ text: "other text" }] });
  return { ws, notes, child, other, data, deck, costs, assetId };
}
