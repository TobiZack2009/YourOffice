import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { TableEngines } from "../src/sheet/table-engine.js";

/**
 * Plan (sheet)       tables Costs, Rates
 *   Quarter 3        table  Costs
 * Report (sheet)     table  Main
 */
function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (title, parentId) => {
    ws.dispatch("createPage", { type: "sheet", title, ...(parentId ? { parentId } : {}) });
    const list = ws.getChildren(parentId ?? null);
    return list[list.length - 1];
  };
  const table = (pageId, name) => {
    ws.dispatch("createTable", { pageId, name });
    const content = ws.getPage(pageId).content;
    return content.tableOrder[content.tableOrder.length - 1];
  };
  const plan = page("Plan");
  const q3 = page("Quarter 3", plan);
  const report = page("Report");
  const ids = {
    costs: table(plan, "Costs"),
    rates: table(plan, "Rates"),
    q3Costs: table(q3, "Costs"),
    main: table(report, "Main")
  };
  const owners = { [ids.costs]: plan, [ids.rates]: plan, [ids.q3Costs]: q3, [ids.main]: report };
  const set = (tableId, key, cell) => {
    const [col, row] = key.split(",").map(Number);
    ws.dispatch("setCell", { pageId: owners[tableId], tableId, col, row, cell });
  };
  const engines = new TableEngines(() => ws._data);
  const tableOf = (tableId) => ws.getPage(owners[tableId]).content.tables[tableId];
  const display = (tableId, key) => {
    engines.refresh();
    const [col, row] = key.split(",").map(Number);
    return engines.display(tableOf(tableId), col, row);
  };
  return { ws, ids, set, display, plan, q3, report, owners, tableOf };
}

describe("cross-table formulas", () => {
  it("reads a cell in another table through a bare name", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { value: 40 });
    set(ids.rates, "0,0", { formula: "=Costs!A1 * 2" });
    expect(display(ids.rates, "0,0")).toBe("80");
  });

  it("reads tables on other pages through a path, and ranges", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { value: 1 });
    set(ids.costs, "0,1", { value: 2 });
    set(ids.costs, "0,2", { value: 3 });
    set(ids.main, "0,0", { formula: "=SUM(Plan!Costs!A1:A3)" });
    set(ids.q3Costs, "0,0", { value: 8 });
    set(ids.main, "1,0", { formula: "=Plan!'Quarter 3'!Costs!A1" });
    expect(display(ids.main, "0,0")).toBe("6");
    expect(display(ids.main, "1,0")).toBe("8");
  });

  it("recalculates when the other table changes", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { value: 1 });
    set(ids.main, "0,0", { formula: "=Plan!Costs!A1 + 1" });
    expect(display(ids.main, "0,0")).toBe("2");
    set(ids.costs, "0,0", { value: 10 });
    expect(display(ids.main, "0,0")).toBe("11");
  });

  it("sums a whole table by name", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { value: 4 });
    set(ids.costs, "1,1", { value: 5 });
    set(ids.main, "0,0", { formula: "=SUM(Plan!Costs)" });
    expect(display(ids.main, "0,0")).toBe("9");
  });

  it("calculates tables that refer to each other when no cell does", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { formula: "=Rates!A1 + 1" });
    set(ids.rates, "0,0", { value: 5 });
    set(ids.rates, "1,0", { formula: "=Costs!B1" });
    set(ids.costs, "1,0", { value: 7 });
    expect(display(ids.costs, "0,0")).toBe("6");
    expect(display(ids.rates, "1,0")).toBe("7");
  });

  it("finds a cell-level cycle across tables", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { formula: "=Rates!A1" });
    set(ids.rates, "0,0", { formula: "=Costs!A1" });
    expect(display(ids.costs, "0,0")).toBe("#CIRC!");
    expect(display(ids.rates, "0,0")).toBe("#CIRC!");
  });

  it("explains an unknown name", () => {
    const { ids, set, display, ws } = setup();
    set(ids.main, "0,0", { formula: "=Plan!Cots!A1" });
    expect(display(ids.main, "0,0")).toBe("#NAME?");
    const engines = new TableEngines(() => ws._data);
    engines.refresh();
    const [pageId] = ws.getChildren(null).slice(-1);
    const table = ws.getPage(pageId).content.tables[ids.main];
    expect(engines.value(table, 0, 0).detail).toContain('Did you mean "Costs"?');
  });

  it("keeps scopes apart: same cell address in two tables", () => {
    const { ids, set, display } = setup();
    set(ids.costs, "0,0", { value: 1 });
    set(ids.q3Costs, "0,0", { value: 2 });
    set(ids.main, "0,0", { formula: "=Plan!Costs!A1 + Plan!'Quarter 3'!Costs!A1" });
    expect(display(ids.main, "0,0")).toBe("3");
  });
});

describe("editing a table rewrites formulas that name it", () => {
  const read = (ws, owners, tableId, key) =>
    ws.getPage(owners[tableId]).content.tables[tableId].cells[key].formula;

  it("shifts qualified references on insertRow, in other tables and pages", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.rates, "0,0", { formula: "=Costs!A3 + A1" });
    set(ids.main, "0,0", { formula: "=SUM(Plan!Costs!A2:B4) + A3" });
    ws.dispatch("insertRow", { pageId: plan, tableId: ids.costs, index: 1 });
    expect(read(ws, owners, ids.rates, "0,0")).toBe("=Costs!A4 + A1");
    expect(read(ws, owners, ids.main, "0,0")).toBe("=SUM(Plan!Costs!A3:B5) + A3");
  });

  it("does not shift a table's unqualified references for another table's edit", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.rates, "0,0", { formula: "=A3" });
    ws.dispatch("insertRow", { pageId: plan, tableId: ids.costs, index: 0 });
    expect(read(ws, owners, ids.rates, "0,0")).toBe("=A3");
  });

  it("shifts qualified references to its own table and its unqualified ones once", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.costs, "1,0", { formula: "=A2 + Costs!A2" });
    ws.dispatch("insertRow", { pageId: plan, tableId: ids.costs, index: 0 });
    expect(read(ws, owners, ids.costs, "1,1")).toBe("=A3 + Costs!A3");
  });

  it("turns a deleted target into #REF! everywhere", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.main, "0,0", { formula: "=Plan!Costs!B1 + Plan!Costs!A1" });
    ws.dispatch("deleteColumn", { pageId: plan, tableId: ids.costs, index: 1 });
    expect(read(ws, owners, ids.main, "0,0")).toBe("=#REF! + Plan!Costs!A1");
  });

  it("is a single undoable transaction", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.main, "0,0", { formula: "=Plan!Costs!A2" });
    ws.dispatch("insertColumn", { pageId: plan, tableId: ids.costs, index: 0 });
    expect(read(ws, owners, ids.main, "0,0")).toBe("=Plan!Costs!B2");
    ws.undo();
    expect(read(ws, owners, ids.main, "0,0")).toBe("=Plan!Costs!A2");
  });

  it("follows insertCells and deleteCells", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.main, "0,0", { formula: "=Plan!Costs!A2" });
    const range = { start: { col: 0, row: 0 }, end: { col: 0, row: 0 } };
    ws.dispatch("insertCells", { pageId: plan, tableId: ids.costs, range, direction: "down" });
    expect(read(ws, owners, ids.main, "0,0")).toBe("=Plan!Costs!A3");
    ws.dispatch("deleteCells", { pageId: plan, tableId: ids.costs, range, direction: "up" });
    expect(read(ws, owners, ids.main, "0,0")).toBe("=Plan!Costs!A2");
  });

  it("follows moveCells within the table, for formulas anywhere", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.costs, "0,0", { value: 5 });
    set(ids.costs, "2,2", { formula: "=A1" });
    set(ids.main, "0,0", { formula: "=Plan!Costs!A1" });
    const source = { start: { col: 0, row: 0 }, end: { col: 0, row: 0 } };
    ws.dispatch("moveCells", { pageId: plan, tableId: ids.costs, source, to: { col: 1, row: 3 } });
    expect(read(ws, owners, ids.main, "0,0")).toBe("=Plan!Costs!B4");
    expect(read(ws, owners, ids.costs, "2,2")).toBe("=B4");
  });

  it("respells references to cells moved into another table", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.costs, "0,0", { value: 5 });
    set(ids.costs, "2,2", { formula: "=A1" });
    set(ids.rates, "1,1", { formula: "=Costs!A1" });
    set(ids.main, "0,0", { formula: "=Plan!Costs!A1" });
    const source = { start: { col: 0, row: 0 }, end: { col: 0, row: 0 } };
    ws.dispatch("moveCells", {
      pageId: plan,
      tableId: ids.rates,
      sourceTableId: ids.costs,
      source,
      to: { col: 2, row: 0 }
    });
    expect(read(ws, owners, ids.costs, "2,2")).toBe("=Rates!C1");
    expect(read(ws, owners, ids.rates, "1,1")).toBe("=C1");
    expect(read(ws, owners, ids.main, "0,0")).toBe("=Plan!Rates!C1");
  });

  it("leaves a formula inside the moved block to the relative-offset rule", () => {
    const { ws, ids, set, plan, owners } = setup();
    set(ids.costs, "0,0", { value: 5 });
    set(ids.costs, "1,0", { formula: "=A1" });
    const source = { start: { col: 0, row: 0 }, end: { col: 1, row: 0 } };
    ws.dispatch("moveCells", { pageId: plan, tableId: ids.costs, source, to: { col: 0, row: 2 } });
    expect(read(ws, owners, ids.costs, "1,2")).toBe("=A3");
  });
});

