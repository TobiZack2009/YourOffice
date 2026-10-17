import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { TableEngines } from "../src/sheet/table-engine.js";
import {
  HEADER_HEIGHT,
  HEADER_WIDTH,
  columnWidthOf,
  renderSheet,
  renderTable,
  resolveCell,
  rowHeightOf,
  tableExtent
} from "../src/sheet/render.js";

function setup(blocks = {}) {
  const ws = Workspace.create({ title: "S" });
  registerSheetCommands(ws);
  ws.dispatch("createPage", { type: "sheet", title: "Sheet" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createTable", { pageId, name: "Budget", rows: 4, columns: 3 });
  const tableId = ws.getPage(pageId).content.tableOrder[0];
  for (const [key, cell] of Object.entries(blocks)) {
    const [col, row] = key.split(",").map(Number);
    ws.dispatch("setCell", { pageId, tableId, col, row, cell });
  }
  const content = () => ws.getPage(pageId).content;
  const table = () => content().tables[tableId];
  const engines = new TableEngines();
  return { ws, pageId, tableId, table, content, engines };
}

describe("table metrics", () => {
  it("reports grid size including headers", () => {
    const { table } = setup();
    const extent = tableExtent(table());
    expect(extent.width).toBe(HEADER_WIDTH + 3 * 96);
    expect(extent.height).toBe(HEADER_HEIGHT + 4 * 24);
  });

  it("honours row and column overrides", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setColumnWidth", { pageId, tableId, column: 1, width: 150 });
    ws.dispatch("setRowHeight", { pageId, tableId, row: 2, height: 40 });
    expect(columnWidthOf(table(), 1)).toBe(150);
    expect(rowHeightOf(table(), 2)).toBe(40);
    expect(tableExtent(table()).width).toBe(HEADER_WIDTH + 96 + 150 + 96);
  });
});

describe("resolveCell", () => {
  it("resolves blanks, literals and formulas", () => {
    const { table, engines } = setup({
      "0,0": { value: 42 },
      "1,0": { formula: "=A1*2" }
    });
    engines.rebuild(table());
    expect(resolveCell(table(), 2, 2, { engines })).toEqual({ display: "", kind: "blank", error: false });
    expect(resolveCell(table(), 0, 0, { engines })).toEqual({ display: "42", kind: "literal", error: false });
    expect(resolveCell(table(), 1, 0, { engines })).toMatchObject({ display: "84", kind: "formula" });
  });

  it("flags error results", () => {
    const { table, engines } = setup({ "0,0": { formula: "=1/0" } });
    engines.rebuild(table());
    const info = resolveCell(table(), 0, 0, { engines });
    expect(info.error).toBe(true);
    expect(info.display).toBe("#DIV/0!");
  });
});

describe("renderTable", () => {
  it("renders headers, cells and values", () => {
    const { table, engines } = setup({ "0,0": { value: 5 }, "2,3": { formula: "=A1+1" } });
    engines.rebuild(table());
    const element = renderTable(table(), { engines });

    expect(element.getAttribute("data-table-id")).toBe(table().id);
    expect(element.querySelector(".sheet-table-name")?.textContent).toBe("Budget");
    expect([...element.querySelectorAll(".sheet-col-header")].map((th) => th.textContent)).toEqual([
      "A",
      "B",
      "C"
    ]);
    expect(element.querySelectorAll(".sheet-row-header")).toHaveLength(4);
    expect(element.querySelector('[data-key="0,0"]')?.textContent).toBe("5");
    expect(element.querySelector('[data-key="2,3"]')?.textContent).toBe("6");
    expect(element.querySelectorAll(".sheet-cell")).toHaveLength(12);
  });

  it("positions the table on the canvas", () => {
    const { ws, pageId, tableId, table, engines } = setup();
    ws.dispatch("moveTable", { pageId, tableId, x: 140, y: 60 });
    const element = renderTable(table(), { engines });
    expect(element.style.left).toBe("140px");
    expect(element.style.top).toBe("60px");
  });

  it("renders merged ranges as spans and skips covered cells", () => {
    const { ws, pageId, tableId, table } = setup({ "0,0": { value: "Title" } });
    ws.dispatch("mergeCells", {
      pageId,
      tableId,
      start: { col: 0, row: 0 },
      end: { col: 2, row: 1 }
    });
    const element = renderTable(table(), {});
    const anchor = element.querySelector('[data-key="0,0"]');
    expect(anchor?.getAttribute("colspan")).toBe("3");
    expect(anchor?.getAttribute("rowspan")).toBe("2");
    expect(anchor?.classList.contains("is-merged-anchor")).toBe(true);
    expect(element.querySelector('[data-key="1,0"]')).toBeNull();
    expect(element.querySelector('[data-key="2,1"]')).toBeNull();
    expect(element.querySelectorAll(".sheet-cell")).toHaveLength(12 - 5);
  });

  it("highlights the selected cell", () => {
    const { table } = setup();
    const element = renderTable(table(), { selected: { tableId: table().id, col: 1, row: 2 } });
    const selected = element.querySelectorAll(".sheet-cell.is-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-key")).toBe("1,2");
  });

  it("marks every cell in a range and keeps the active cell distinct", () => {
    const { table } = setup();
    const id = table().id;
    const element = renderTable(table(), {
      selected: {
        tableId: id,
        col: 0,
        row: 0,
        range: { tableId: id, start: { col: 0, row: 0 }, end: { col: 1, row: 1 } }
      }
    });
    const inRange = [...element.querySelectorAll(".sheet-cell.is-in-range")].map((el) => el.getAttribute("data-key"));
    expect(inRange.sort()).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    expect(element.querySelectorAll(".sheet-cell.is-selected")).toHaveLength(1);
  });

  it("does not mark a single-cell range", () => {
    const { table } = setup();
    const id = table().id;
    const element = renderTable(table(), {
      selected: { tableId: id, col: 1, row: 1, range: { tableId: id, start: { col: 1, row: 1 }, end: { col: 1, row: 1 } } }
    });
    expect(element.querySelectorAll(".sheet-cell.is-in-range")).toHaveLength(0);
  });

  it("highlights a merged cell as a unit when the range touches it", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("mergeCells", { pageId, tableId, start: { col: 0, row: 0 }, end: { col: 1, row: 1 } });
    const element = renderTable(table(), {
      selected: {
        tableId,
        col: 1,
        row: 2,
        range: { tableId, start: { col: 1, row: 1 }, end: { col: 1, row: 2 } }
      }
    });
    expect(element.querySelector('[data-key="0,0"]')?.classList.contains("is-in-range")).toBe(true);
  });

  it("applies row heights and column widths", () => {
    const { ws, pageId, tableId, table } = setup();
    ws.dispatch("setColumnWidth", { pageId, tableId, column: 0, width: 130 });
    const element = renderTable(table(), {});
    const col = element.querySelector('colgroup col[data-col="0"]');
    expect(col?.style.width).toBe("130px");
  });
});

describe("renderSheet", () => {
  it("renders tables in z-order with canvas bounds", () => {
    const { ws, pageId, tableId, table, engines, content } = setup();
    ws.dispatch("createTable", { pageId, name: "Second", rows: 2, columns: 2, x: 400, y: 300 });
    const canvas = renderSheet(content(), { engines });
    const tables = [...canvas.querySelectorAll(".sheet-table")];
    expect(tables).toHaveLength(2);
    expect(tables[0].getAttribute("data-table-id")).toBe(tableId);
    expect(Number.parseFloat(canvas.style.minWidth)).toBeGreaterThan(400);
    expect(Number.parseFloat(canvas.style.minHeight)).toBeGreaterThan(300);
    expect(table().name).toBe("Budget");
  });
});
