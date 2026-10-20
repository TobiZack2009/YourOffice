import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { cellKey, getCell } from "../src/sheet/model.js";
import { CommandError } from "../src/core/errors.js";

function setup() {
  const ws = createWorkspace({ title: "S" });
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

  it("places a new table below the existing ones instead of on top of them", () => {
    const { ws, pageId } = setup();
    ws.dispatch("createTable", { pageId });
    ws.dispatch("createTable", { pageId });
    const content = ws.getPage(pageId).content;
    const [a, b, c] = content.tableOrder.map((id) => content.tables[id]);
    expect(b.position.y).toBeGreaterThan(a.position.y + 5 * a.rowHeight);
    expect(c.position.y).toBeGreaterThan(b.position.y + b.rowCount * b.rowHeight);
    expect(c.position.x).toBe(b.position.x);
  });

  it("rejects creating on a non-sheet page", () => {
    const ws = createWorkspace({ title: "W" });
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    const pageId = ws.getChildren(null)[0];
    expect(() => ws.dispatch("createTable", { pageId })).toThrow(CommandError);
  });
});

describe("table metadata", () => {
  it("renames, moves and deletes tables", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("renameTable", { pageId, tableId, name: "Quarter 1" });
    expect(table().name).toBe("Quarter 1");
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

const rect = (c0, r0, c1 = c0, r1 = r0) => ({ start: { col: c0, row: r0 }, end: { col: c1, row: r1 } });

describe("fillCells", () => {
  it("fills a range from one cell, shifting relative references per target", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1*2" } });
    ws.dispatch("fillCells", { pageId, tableId, source: rect(1, 0), targets: [rect(1, 0, 1, 3)] });
    expect(table().cells["1,1"]).toEqual({ formula: "=A2*2" });
    expect(table().cells["1,3"]).toEqual({ formula: "=A4*2" });
    expect(table().cells["1,0"]).toEqual({ formula: "=A1*2" });
  });

  it("keeps $-pinned references and copies literals as they are", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { formula: "=$B$1+A1" } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: "x" } });
    ws.dispatch("fillCells", { pageId, tableId, source: rect(0, 0), targets: [rect(1, 0, 2, 0)] });
    expect(table().cells["1,0"]).toEqual({ formula: "=$B$1+B1" });
    expect(table().cells["2,0"]).toEqual({ formula: "=$B$1+C1" });
    ws.dispatch("fillCells", { pageId, tableId, source: rect(0, 1), targets: [rect(1, 1, 2, 1)] });
    expect(table().cells["2,1"]).toEqual({ value: "x" });
  });

  it("tiles a multi-cell source over several targets", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { value: 2 } });
    ws.dispatch("fillCells", {
      pageId,
      tableId,
      source: rect(0, 0, 1, 0),
      targets: [rect(0, 2, 1, 3), rect(2, 4)]
    });
    expect(table().cells["0,2"]).toEqual({ value: 1 });
    expect(table().cells["1,3"]).toEqual({ value: 2 });
    expect(table().cells["2,4"]).toEqual({ value: 1 });
  });

  it("clears the targets when the source cell is blank", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 1, cell: { value: 9 } });
    ws.dispatch("fillCells", { pageId, tableId, source: rect(0, 0), targets: [rect(1, 1)] });
    expect(table().cells["1,1"]).toBeUndefined();
  });

  it("grows the table to fit the targets and undoes as one step", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("fillCells", { pageId, tableId, source: rect(0, 0), targets: [rect(0, 1, 4, 1)] });
    expect(table().columnCount).toBe(5);
    ws.undo();
    expect(table().columnCount).toBe(3);
    expect(table().cells["1,1"]).toBeUndefined();
  });

  it("rejects malformed and empty ranges", () => {
    const { ws, pageId, tableId } = setup();
    expect(() => ws.dispatch("fillCells", { pageId, tableId, source: rect(0, 0), targets: [] })).toThrow(CommandError);
    expect(() =>
      ws.dispatch("fillCells", { pageId, tableId, source: rect(2, 2, 0, 0), targets: [rect(0, 0)] })
    ).toThrow(CommandError);
    expect(() => ws.dispatch("fillCells", { pageId, tableId, source: rect(0, 0) , targets: [{}] })).toThrow(CommandError);
  });
});

describe("moveCells", () => {
  it("moves cells, clears the source and shifts the moved formulas' relative references", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1+$A$1" } });
    ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0, 1, 0), to: { col: 1, row: 2 } });
    expect(table().cells["0,0"]).toBeUndefined();
    expect(table().cells["1,0"]).toBeUndefined();
    expect(table().cells["1,2"]).toEqual({ value: 5 });
    expect(table().cells["2,2"]).toEqual({ formula: "=B3+$A$1" });
  });

  it("retargets formulas elsewhere so they keep following the moved cells", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: 7 } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { formula: "=A1*2" } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 1, cell: { formula: "=$A$1+A2" } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 2, cell: { formula: "=SUM(A1:A2)" } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 3, cell: { formula: "=SUM(A1:A5)" } });
    ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0, 0, 1), to: { col: 1, row: 0 } });
    expect(table().cells["2,0"]).toEqual({ formula: "=B1*2" });
    expect(table().cells["2,1"]).toEqual({ formula: "=$B$1+B2" });
    // A range moves only when it sits wholly inside the moved block.
    expect(table().cells["2,2"]).toEqual({ formula: "=SUM(B1:B2)" });
    expect(table().cells["2,3"]).toEqual({ formula: "=SUM(A1:A5)" });
  });

  it("retargets a lone reference while leaving references to other cells alone", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 3, row: 0, cell: { formula: "=B1+C9" } });
    ws.dispatch("moveCells", { pageId, tableId, source: rect(1, 0), to: { col: 1, row: 2 } });
    expect(table().cells["3,0"]).toEqual({ formula: "=B3+C9" });
  });

  it("overwrites the destination, including with blanks", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 1, cell: { value: "old" } });
    ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0, 0, 1), to: { col: 1, row: 0 } });
    expect(table().cells["1,0"]).toEqual({ value: 1 });
    expect(table().cells["1,1"]).toBeUndefined();
  });

  it("handles overlapping source and destination", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "a" } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: "b" } });
    ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0, 0, 1), to: { col: 0, row: 1 } });
    expect(table().cells["0,0"]).toBeUndefined();
    expect(table().cells["0,1"]).toEqual({ value: "a" });
    expect(table().cells["0,2"]).toEqual({ value: "b" });
  });

  it("is a no-op for a zero offset, rejects an off-sheet destination and undoes", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0), to: { col: 0, row: 0 } });
    expect(table().cells["0,0"]).toEqual({ value: 1 });
    expect(() => ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0), to: { col: -1, row: 0 } })).toThrow(
      CommandError
    );
    ws.dispatch("moveCells", { pageId, tableId, source: rect(0, 0), to: { col: 2, row: 2 } });
    ws.undo();
    expect(table().cells["0,0"]).toEqual({ value: 1 });
    expect(table().cells["2,2"]).toBeUndefined();
  });
});

describe("insertCells / deleteCells", () => {
  it("shifts the cells under a range down, and retargets formulas that point at them", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "a" } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: "b" } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 1, cell: { value: "side" } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { formula: "=A2" } });
    ws.dispatch("insertCells", { pageId, tableId, range: rect(0, 0, 0, 0), direction: "down" });
    expect(table().cells["0,0"]).toBeUndefined();
    expect(table().cells["0,1"]).toEqual({ value: "a" });
    expect(table().cells["0,2"]).toEqual({ value: "b" });
    expect(table().cells["1,1"]).toEqual({ value: "side" }); // other columns stay
    expect(table().cells["2,0"]).toEqual({ formula: "=A3" });
  });

  it("shifts right and grows the table to fit", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { value: "edge" } });
    ws.dispatch("insertCells", { pageId, tableId, range: rect(0, 0, 1, 0), direction: "right" });
    expect(table().cells["4,0"]).toEqual({ value: "edge" });
    expect(table().columnCount).toBe(5);
  });

  it("deletes cells, closing the gap and turning references into them into #REF!", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: 2 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 2, cell: { value: 3 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A2+A3" } });
    ws.dispatch("deleteCells", { pageId, tableId, range: rect(0, 1, 0, 1), direction: "up" });
    expect(table().cells["0,1"]).toEqual({ value: 3 });
    expect(table().cells["0,2"]).toBeUndefined();
    expect(table().cells["1,0"]).toEqual({ formula: "=#REF!+A2" });

    ws.dispatch("deleteCells", { pageId, tableId, range: rect(0, 0, 0, 0), direction: "left" });
    expect(table().cells["0,0"]).toEqual({ formula: "=#REF!+A2" });
  });

  it("is one undo step", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "a" } });
    ws.dispatch("insertCells", { pageId, tableId, range: rect(0, 0, 0, 1), direction: "down" });
    expect(table().cells["0,2"]).toEqual({ value: "a" });
    ws.undo();
    expect(table().cells["0,0"]).toEqual({ value: "a" });
    expect(table().cells["0,2"]).toBeUndefined();
  });

  it("refuses to shift through a merged cell", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("mergeCells", { pageId, tableId, start: { col: 0, row: 2 }, end: { col: 1, row: 2 } });
    let error;
    try {
      ws.dispatch("insertCells", { pageId, tableId, range: rect(0, 0, 0, 0), direction: "down" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect(error.reason).toBe("mergedCells");
    // A band that does not meet the merge is fine.
    ws.dispatch("insertCells", { pageId, tableId, range: rect(2, 0, 2, 0), direction: "down" });
    expect(table().merges).toHaveLength(1);
  });

  it("rejects cells pushed off the end of the sheet and bad directions", () => {
    const { ws, pageId, tableId } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1048575, cell: { value: 1 } });
    expect(() =>
      ws.dispatch("insertCells", { pageId, tableId, range: rect(0, 0, 0, 0), direction: "down" })
    ).toThrow(CommandError);
    expect(() =>
      ws.dispatch("insertCells", { pageId, tableId, range: rect(0, 0, 0, 0), direction: "left" })
    ).toThrow(CommandError);
    expect(() =>
      ws.dispatch("deleteCells", { pageId, tableId, range: rect(0, 0, 0, 0), direction: "right" })
    ).toThrow(CommandError);
  });
});
