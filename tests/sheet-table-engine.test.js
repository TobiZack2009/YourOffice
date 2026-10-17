import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { TableEngines } from "../src/sheet/table-engine.js";

function setup() {
  const ws = Workspace.create({ title: "S" });
  registerSheetCommands(ws);
  ws.dispatch("createPage", { type: "sheet", title: "Sheet" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createTable", { pageId, name: "Budget", rows: 6, columns: 4 });
  const tableId = ws.getPage(pageId).content.tableOrder[0];
  const table = () => ws.getPage(pageId).content.tables[tableId];
  const engines = new TableEngines();
  return { ws, pageId, tableId, table, engines };
}

describe("TableEngines", () => {
  it("computes literal and formula values", () => {
    const { ws, pageId, tableId, table, engines } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 10 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=SUM(A1:A2)" } });

    engines.rebuild(table());
    expect(engines.display(table(), 1, 0)).toBe("15");
    expect(engines.value(table(), 0, 0)).toBe(10);
    expect(engines.display(table(), 3, 5)).toBe("");
  });

  it("propagates errors and circular references", () => {
    const { ws, pageId, tableId, table, engines } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { formula: "=B1" } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1" } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { formula: "=1/0" } });
    engines.rebuild(table());
    expect(engines.display(table(), 0, 0)).toBe("#CIRC!");
    expect(engines.display(table(), 2, 0)).toBe("#DIV/0!");
  });

  it("recalculates after dependent cells change", () => {
    const { ws, pageId, tableId, table, engines } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 2 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1*3" } });
    engines.rebuild(table());
    expect(engines.display(table(), 1, 0)).toBe("6");

    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 4 } });
    engines.rebuild(table());
    expect(engines.display(table(), 1, 0)).toBe("12");
  });

  it("keeps tables independent", () => {
    const { ws, pageId, tableId, table, engines } = setup();
    ws.dispatch("createTable", { pageId, name: "Other", rows: 3, columns: 3 });
    const otherId = ws.getPage(pageId).content.tableOrder[1];
    ws.dispatch("setCell", { pageId, tableId: otherId, col: 0, row: 0, cell: { value: 99 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });

    const other = ws.getPage(pageId).content.tables[otherId];
    engines.rebuild(table());
    engines.rebuild(other);
    expect(engines.display(table(), 0, 0)).toBe("1");
    expect(engines.display(other, 0, 0)).toBe("99");
    expect(engines.engine(table())).not.toBe(engines.engine(other));
  });

  it("rebuilds lazily and forgets engines on demand", () => {
    const { ws, pageId, tableId, table, engines } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 3 } });
    const first = engines.engine(table());
    expect(engines.engine(table())).toBe(first);
    engines.forget(tableId);
    expect(engines.engine(table())).not.toBe(first);
  });
});
