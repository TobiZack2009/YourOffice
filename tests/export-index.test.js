import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { bundleExport, exportPages } from "../src/export/index.js";
import { readZip } from "../src/export/zip.js";
import { exportFixture } from "./export-fixture.js";

const decode = (bytes) => new TextDecoder().decode(bytes);

describe("exportPages", () => {
  it("returns files with their types, and what was left out", () => {
    const { ws } = exportFixture();
    const html = exportPages(ws, { format: "html" }, { document });
    expect(html.files.every((f) => f.mime === "text/html")).toBe(true);
    const md = exportPages(ws, { format: "markdown" });
    expect(md.files.every((f) => f.mime === "text/markdown")).toBe(true);
    const csv = exportPages(ws, { format: "csv" });
    expect(csv.files.map((f) => f.mime)).toEqual(["text/csv"]);
    expect(csv.skipped.map((s) => s.title)).toEqual(["Notes", "Child", "Other", "Deck"]);
  });

  it("does not change the workspace", () => {
    const { ws } = exportFixture();
    const before = JSON.stringify(ws.data);
    const undoable = ws.canUndo;
    exportPages(ws, { format: "html" }, { document });
    exportPages(ws, { format: "markdown" }, { document });
    expect(JSON.stringify(ws.data)).toBe(before);
    expect(ws.canUndo).toBe(undoable);
  });

  it("warns when there is nothing to export", () => {
    const ws = createWorkspace({ title: "Empty" });
    const result = exportPages(ws, { format: "markdown" });
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual(["There is nothing to export."]);
    expect(bundleExport(result, "Empty")).toBeNull();
  });

  it("de-duplicates warnings", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId } = ws.dispatch("createPage", { type: "document", title: "Page" });
    for (const id of ["a", "b"]) {
      ws.dispatch("insertBlock", { pageId, newBlockId: id, block: { type: "image", assetId: "asset_gone", alt: "Lost" } });
    }
    expect(exportPages(ws, { format: "markdown" }).warnings).toHaveLength(1);
  });
});

describe("CSV", () => {
  it("names a one-table sheet after the page", () => {
    const { ws } = exportFixture();
    const result = exportPages(ws, { format: "csv" });
    expect(result.files).toEqual([{ path: "Data.csv", mime: "text/csv", text: "5,10\r\n7,\r\n" }]);
  });

  it("names each table of a sheet with several", () => {
    const { ws, data } = exportFixture();
    ws.dispatch("createTable", { pageId: data, name: "Second Table" });
    const second = ws.getPage(data).content.tableOrder[1];
    ws.dispatch("setCell", { pageId: data, tableId: second, col: 0, row: 0, cell: { value: "x,y" } });
    const result = exportPages(ws, { format: "csv" });
    expect(result.files.map((f) => f.path)).toEqual(["Data-Costs.csv", "Data-Second-Table.csv"]);
    expect(result.files[1].text).toBe('"x,y"\r\n');
  });

  it("warns about a sheet with no tables", () => {
    const ws = createWorkspace({ title: "W" });
    ws.dispatch("createPage", { type: "sheet", title: "Blank" });
    const result = exportPages(ws, { format: "csv" });
    expect(result.files).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Blank");
  });
});

describe("bundleExport", () => {
  it("hands over a single file as it is", () => {
    const { ws, other } = exportFixture();
    const bundle = bundleExport(exportPages(ws, { format: "markdown", pageIds: [other] }), "ignored");
    expect(bundle.name).toBe("Other.md");
    expect(bundle.mime).toBe("text/markdown");
    expect(decode(bundle.bytes)).toBe("# Other\n\nother text\n");
  });

  it("zips several files, keeping their folders", () => {
    const { ws, notes } = exportFixture();
    const bundle = bundleExport(exportPages(ws, { format: "markdown", pageIds: [notes], subfolders: true }), "My notes / draft");
    expect(bundle.name).toBe("My-notes-draft.zip");
    expect(bundle.mime).toBe("application/zip");
    const entries = readZip(bundle.bytes);
    expect(entries.map((e) => e.path)).toEqual(["Notes.md", "Notes/Child.md", "Other.md", "index.md"]);
    expect(decode(entries[1].data)).toBe("# Child\n\nchild text\n");
  });

  it("zips an HTML export with its index", () => {
    const { ws } = exportFixture();
    const bundle = bundleExport(exportPages(ws, { format: "html" }, { document }), "all");
    const paths = readZip(bundle.bytes).map((e) => e.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("Deck.html");
  });
});
