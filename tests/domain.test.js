import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { WorkspaceFormatError } from "../src/core/errors.js";
import { validateWorkspace } from "../src/workspace/schema.js";
import {
  createWorkspace,
  domainValidation,
  installDomain,
  validateDomain,
  workspaceFromJSON
} from "../src/domain/index.js";

describe("the bare Workspace", () => {
  it("registers only the workspace commands", () => {
    const ws = Workspace.create({ title: "Bare" });
    expect(ws.hasCommand("createPage")).toBe(true);
    for (const type of ["insertBlock", "createTable", "createSlide", "createSection"]) {
      expect(ws.hasCommand(type)).toBe(false);
    }
  });

  it("checks only the envelope when no validation is configured", () => {
    const ws = Workspace.create({ title: "Bare" });
    ws.dispatch("createPage", { type: "document" });
    const doc = ws.serialized;
    doc.pages[Object.keys(doc.pages)[0]].content = { nonsense: true };
    expect(validateWorkspace(doc).valid).toBe(true);
    expect(validateDomain(doc).valid).toBe(false);
  });
});

describe("installDomain", () => {
  it("registers every feature, once", () => {
    const ws = Workspace.create({ title: "T" });
    expect(installDomain(ws)).toBe(ws);
    expect(installDomain(ws)).toBe(ws);
    for (const type of ["insertBlock", "createTable", "createSlide", "createSection", "insertReference"]) {
      expect(ws.hasCommand(type), type).toBe(true);
    }
    expect(ws.validationOptions).toBe(domainValidation);
  });

  it("records registration metadata instead of hand lists", () => {
    const ws = createWorkspace({ title: "T" });
    expect(ws.commandMeta("setBlockRuns").hot).toBe(true);
    expect(ws.commandMeta("setCell").hot).toBe(true);
    expect(ws.commandMeta("setObjectRuns").hot).toBe(true);
    expect(ws.commandMeta("renameWorkspace").hot).toBe(true);
    expect(ws.commandMeta("deletePage").selfManaged).toBe(true);
    expect(ws.commandMeta("resizeSection").selfManaged).toBe(true);
    expect(ws.commandMeta("createPage")).toEqual({ hot: false, selfManaged: false, registry: true, inline: false });
    expect(ws.commandMeta("setBlockRuns").registry).toBe(false);
    expect(ws.commandMeta("setBlockRuns").inline).toBe(true);
    expect(ws.commandMeta("insertBlock").inline).toBe(false);
    expect(ws.commandMeta("noSuchCommand")).toEqual({ hot: false, selfManaged: false, registry: false, inline: false });
  });
});

describe("workspaceFromJSON", () => {
  it("round-trips an installed workspace and installs the result", () => {
    const ws = createWorkspace({ title: "Round" });
    ws.dispatch("createPage", { type: "sheet", title: "S" });
    const restored = workspaceFromJSON(ws.serialized);
    expect(restored.hasCommand("setCell")).toBe(true);
    expect(restored.getPages()).toEqual(ws.getPages());
  });

  it("applies the full rules", () => {
    const ws = createWorkspace({ title: "Bad" });
    ws.dispatch("createPage", { type: "sheet" });
    const doc = ws.serialized;
    doc.pages[Object.keys(doc.pages)[0]].content = { tables: [] };
    expect(() => workspaceFromJSON(doc)).toThrow(WorkspaceFormatError);
  });
});

describe("page rename hook", () => {
  it("respells formulas that name a renamed page through the reference hook, not the page command", () => {
    const ws = createWorkspace({ title: "T" });
    ws.dispatch("createPage", { type: "sheet", title: "Source" });
    ws.dispatch("createPage", { type: "sheet", title: "Report" });
    const [source, report] = ws.getChildren(null);
    ws.dispatch("createTable", { pageId: source, name: "Costs", rows: 3, columns: 2 });
    ws.dispatch("createTable", { pageId: report, name: "Out", rows: 3, columns: 2 });
    const tableId = ws.getPage(source).content.tableOrder[0];
    const outId = ws.getPage(report).content.tableOrder[0];
    ws.dispatch("setCell", { pageId: source, tableId, col: 0, row: 0, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId: report, tableId: outId, col: 0, row: 0, cell: { formula: "=Source::Costs::A1" } });
    ws.dispatch("renamePage", { pageId: source, title: "Ledger" });
    expect(ws.getPage(report).content.tables[outId].cells["0,0"].formula).toContain("Ledger");
  });
});
