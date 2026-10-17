import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { cellKey, getCell } from "../src/sheet/model.js";
import { CommandError } from "../src/core/errors.js";

function setup() {
  const ws = Workspace.create({ title: "S" });
  registerSheetCommands(ws);
  ws.dispatch("createPage", { type: "sheet", title: "Sheet" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createTable", { pageId, name: "Budget", rows: 5, columns: 3 });
  const content = ws.getPage(pageId).content;
  const tableId = content.tableOrder[0];
  return {
    ws,
    pageId,
    tableId,
    table: () => ws.getPage(pageId).content.tables[tableId]
  };
}

describe("createTable", () => {
  it("appends tables in z-order with generated names", () => {
    const { ws, pageId } = setup();
    ws.dispatch("createTable", { pageId });
    const content = ws.getPage(pageId).content;
    expect(content.tableOrder).toHaveLength(2);
    expect(content.tables[content.tableOrder[1]].name).toBe("Table 2");
  });

  it("rejects creating on a non-sheet page", () => {
    const ws = Workspace.create({ title: "W" });
    registerSheetCommands(ws);
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    const pageId = ws.getChildren(null)[0];
    expect(() => ws.dispatch("createTable", { pageId })).toThrow(CommandError);
  });
});

describe("table metadata", () => {
  it("renames, moves and deletes tables", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("renameTable", { pageId, tableId, name: "Q1" });
    expect(table().name).toBe("Q1");
    ws.dispatch("moveTable", { pageId, tableId, x: 120, y: 40 });
    expect(table().position).toEqual({ x: 120, y: 40 });
    ws.dispatch("deleteTable", { pageId, tableId });
    expect(ws.getPage(pageId).content.tableOrder).toEqual([]);
  });

  it("rejects moving to non-finite positions", () => {
    const { ws, pageId, tableId } = setup();
    expect(() => ws.dispatch("moveTable", { pageId, tableId, x: NaN, y: 0 })).toThrow(CommandError);
  });
});

describe("setCell", () => {
  it("stores literals sparsely", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 10 } });
    expect(table().cells["0,0"]).toEqual({ value: 10 });
    expect(Object.keys(table().cells)).toHaveLength(1);
  });

  it("promotes strings starting with '=' to formulas", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { value: "=A1" } });
    expect(table().cells["1,0"]).toEqual({ formula: "=A1" });
  });

  it("clears cells with null or an empty string", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "" } });
    expect(table().cells["0,0"]).toBeUndefined();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 7 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: null });
    expect(table().cells["0,0"]).toBeUndefined();
  });

  it("grows the table to fit a position beyond its bounds", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 4, row: 9, cell: { value: "x" } });
    expect(table().columnCount).toBe(5);
    expect(table().rowCount).toBe(10);
    expect(getCell(table(), 4, 9)).toEqual({ value: "x" });
  });

  it("rejects invalid cell payloads", () => {
    const { ws, pageId, tableId } = setup();
    expect(() =>
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1, formula: "=A1" } })
    ).toThrow(CommandError);
    expect(() =>
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { formula: "A1" } })
    ).toThrow(CommandError);
    expect(() => ws.dispatch("setCell", { pageId, tableId, col: -1, row: 0, cell: { value: 1 } })).toThrow(
      CommandError
    );
  });
});

describe("row operations", () => {
  it("inserts rows, shifting cells and formulas down", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 1, cell: { formula: "=A1*2" } });
    ws.dispatch("insertRow", { pageId, tableId, index: 0 });

    expect(table().rowCount).toBe(6);
    expect(Object.keys(table().cells).sort()).toEqual(["0,1", "1,2"]);
    expect(table().cells["1,2"]).toEqual({ formula: "=A2*2" });
  });

  it("inserts multiple rows at an index, leaving earlier rows alone", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "top" } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 2, cell: { value: "low" } });
    ws.dispatch("insertRow", { pageId, tableId, index: 2, count: 2 });
    expect(table().rowCount).toBe(7);
    expect(table().cells["0,0"]).toEqual({ value: "top" });
    expect(table().cells["0,4"]).toEqual({ value: "low" });
  });

  it("deletes rows, dropping their cells and producing #REF! in references", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: 2 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 3, cell: { formula: "=A1+A2" } });
    ws.dispatch("deleteRow", { pageId, tableId, index: 1 });

    expect(table().rowCount).toBe(4);
    expect(table().cells[cellKey(0, 1)]).toBeUndefined();
    expect(table().cells["1,2"]).toEqual({ formula: "=A1+#REF!" });
  });

  it("refuses to delete every row", () => {
    const { ws, pageId, tableId } = setup();
    expect(() => ws.dispatch("deleteRow", { pageId, tableId, index: 0, count: 5 })).toThrow(CommandError);
  });

  it("rejects out-of-range indices", () => {
    const { ws, pageId, tableId } = setup();
    expect(() => ws.dispatch("insertRow", { pageId, tableId, index: 9 })).toThrow(CommandError);
    expect(() => ws.dispatch("deleteRow", { pageId, tableId, index: 9 })).toThrow(CommandError);
  });
});

describe("column operations", () => {
  it("inserts and deletes columns, rewriting references", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { formula: "=A1+1" } });
    ws.dispatch("insertColumn", { pageId, tableId, index: 1 });

    expect(table().columnCount).toBe(4);
    expect(table().cells["3,0"]).toEqual({ formula: "=A1+1" });

    ws.dispatch("deleteColumn", { pageId, tableId, index: 0 });
    expect(table().columnCount).toBe(3);
    // A was deleted, so the reference is now broken and the formula shifted too.
    expect(table().cells["2,0"]).toEqual({ formula: "=#REF!+1" });
  });
});

describe("row and column sizing", () => {
  it("sets and clears overrides", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setRowHeight", { pageId, tableId, row: 1, height: 40 });
    ws.dispatch("setColumnWidth", { pageId, tableId, column: 2, width: 150 });
    expect(table().rowOverrides).toEqual({ 1: { height: 40 } });
    expect(table().columnOverrides).toEqual({ 2: { width: 150 } });

    ws.dispatch("setRowHeight", { pageId, tableId, row: 1, height: null });
    expect(table().rowOverrides).toEqual({});
  });

  it("rejects invalid sizes and indices", () => {
    const { ws, pageId, tableId } = setup();
    expect(() => ws.dispatch("setRowHeight", { pageId, tableId, row: 0, height: 0 })).toThrow(CommandError);
    expect(() => ws.dispatch("setColumnWidth", { pageId, tableId, column: 99, width: 10 })).toThrow(
      CommandError
    );
  });

  it("keeps overrides aligned when lines are inserted or deleted", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setRowHeight", { pageId, tableId, row: 2, height: 30 });
    ws.dispatch("insertRow", { pageId, tableId, index: 0 });
    expect(table().rowOverrides).toEqual({ 3: { height: 30 } });
    ws.dispatch("deleteRow", { pageId, tableId, index: 0 });
    expect(table().rowOverrides).toEqual({ 2: { height: 30 } });
  });
});

describe("merges", () => {
  it("merges a rectangle and unmerges it", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("mergeCells", {
      pageId,
      tableId,
      start: { col: 0, row: 0 },
      end: { col: 1, row: 1 }
    });
    expect(table().merges).toEqual([{ start: { col: 0, row: 0 }, end: { col: 1, row: 1 } }]);

    ws.dispatch("unmergeCells", { pageId, tableId, col: 1, row: 1 });
    expect(table().merges).toEqual([]);
  });

  it("rejects single-cell, overlapping and out-of-bounds merges", () => {
    const { ws, pageId, tableId } = setup();
    expect(() =>
      ws.dispatch("mergeCells", { pageId, tableId, start: { col: 0, row: 0 }, end: { col: 0, row: 0 } })
    ).toThrow(CommandError);

    ws.dispatch("mergeCells", { pageId, tableId, start: { col: 0, row: 0 }, end: { col: 1, row: 1 } });
    expect(() =>
      ws.dispatch("mergeCells", { pageId, tableId, start: { col: 1, row: 1 }, end: { col: 2, row: 2 } })
    ).toThrow(CommandError);
    expect(() => ws.dispatch("unmergeCells", { pageId, tableId, col: 2, row: 2 })).toThrow(CommandError);
  });

  it("moves merges with inserted rows", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("mergeCells", { pageId, tableId, start: { col: 0, row: 2 }, end: { col: 1, row: 2 } });
    ws.dispatch("insertRow", { pageId, tableId, index: 0 });
    expect(table().merges).toEqual([{ start: { col: 0, row: 3 }, end: { col: 1, row: 3 } }]);
  });
});

describe("history integration", () => {
  it("undoes a row insertion as one transaction", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("insertRow", { pageId, tableId, index: 0, count: 3 });
    expect(table().rowCount).toBe(8);
    ws.undo();
    expect(table().rowCount).toBe(5);
    expect(table().cells["0,0"]).toEqual({ value: 1 });
  });
});
