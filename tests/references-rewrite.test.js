import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { CommandError } from "../src/core/errors.js";
import { retargetReferences, snapshotReferences } from "../src/references/rewrite.js";

/**
 * Plan (sheet)           tables Costs, Rates
 *   Q3 Budget (sheet)    table  Costs
 * Report (sheet)         table  Main, with the formulas under test
 */
function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (title, parentId) => {
    ws.dispatch("createPage", { type: "sheet", title, ...(parentId ? { parentId } : {}) });
    const list = parentId ? ws.getChildren(parentId) : ws.getChildren(null);
    return list[list.length - 1];
  };
  const table = (pageId, name) => {
    ws.dispatch("createTable", { pageId, name });
    const content = ws.getPage(pageId).content;
    return content.tableOrder[content.tableOrder.length - 1];
  };
  const plan = page("Plan");
  const q3 = page("Q3 Budget", plan);
  const report = page("Report");
  const ids = {
    planCosts: table(plan, "Costs"),
    planRates: table(plan, "Rates"),
    q3Costs: table(q3, "Costs"),
    main: table(report, "Main")
  };
  const formula = (key, text) =>
    ws.dispatch("setCell", {
      pageId: report,
      tableId: ids.main,
      col: Number(key.split(",")[0]),
      row: Number(key.split(",")[1]),
      cell: { formula: text }
    });
  const read = (key) => ws.getPage(report).content.tables[ids.main].cells[key].formula;
  return { ws, plan, q3, report, ids, formula, read };
}

describe("renaming a table", () => {
  it("respells every qualified reference to it, keeping addresses and spacing", () => {
    const { ws, plan, ids, formula, read } = setup();
    formula("0,0", "=SUM(  Plan!Costs!A1:B3 ) + Plan!Costs!C1");
    formula("1,0", "=Plan!Rates!A1");
    ws.dispatch("renameTable", { pageId: plan, tableId: ids.planCosts, name: "Spend" });
    expect(read("0,0")).toBe("=SUM(  Plan!Spend!A1:B3 ) + Plan!Spend!C1");
    expect(read("1,0")).toBe("=Plan!Rates!A1");
  });

  it("quotes names that need it", () => {
    const { ws, plan, ids, formula, read } = setup();
    formula("0,0", "=Plan!Rates");
    ws.dispatch("renameTable", { pageId: plan, tableId: ids.planRates, name: "Tax rates" });
    expect(read("0,0")).toBe("=Plan!'Tax rates'");
  });

  it("is one undoable transaction", () => {
    const { ws, plan, ids, formula, read } = setup();
    formula("0,0", "=Plan!Costs!A1");
    ws.dispatch("renameTable", { pageId: plan, tableId: ids.planCosts, name: "Spend" });
    expect(read("0,0")).toBe("=Plan!Spend!A1");
    ws.undo();
    expect(read("0,0")).toBe("=Plan!Costs!A1");
  });

  it("auto-suffixes a name already used on the page", () => {
    const { ws, plan, ids } = setup();
    ws.dispatch("renameTable", { pageId: plan, tableId: ids.planRates, name: "costs" });
    expect(ws.getPage(plan).content.tables[ids.planRates].name).toBe("costs 2");
  });

  it("refuses names the formula language cannot read", () => {
    const { ws, plan, ids } = setup();
    for (const name of ["B2", "TRUE", "SUM(x)", ""]) {
      expect(() => ws.dispatch("renameTable", { pageId: plan, tableId: ids.planRates, name })).toThrow(CommandError);
    }
  });
});

describe("creating a table", () => {
  it("auto-suffixes duplicate names on the page", () => {
    const { ws, plan } = setup();
    ws.dispatch("createTable", { pageId: plan, name: "Costs" });
    const content = ws.getPage(plan).content;
    expect(content.tables[content.tableOrder.at(-1)].name).toBe("Costs 2");
  });
});

describe("renaming a page", () => {
  it("respells references that went through the old title", () => {
    const { ws, plan, formula, read } = setup();
    formula("0,0", "=Plan!Rates!A1 + Plan!'Q3 Budget'");
    ws.dispatch("renamePage", { pageId: plan, title: "Planning" });
    expect(read("0,0")).toBe("=Planning!Rates!A1 + Planning!'Q3 Budget'");
  });

  it("respells paths with a quoted page name", () => {
    const { ws, q3, formula, read } = setup();
    formula("0,0", "='Q3 Budget'!Costs!B2");
    formula("1,0", "=Plan!'Q3 Budget'!Costs");
    ws.dispatch("renamePage", { pageId: q3, title: "Q4 Budget" });
    expect(read("0,0")).toBe("='Q3 Budget'!Costs!B2");
    expect(read("1,0")).toBe("=Plan!'Q4 Budget'!Costs");
  });
});

describe("moving a page", () => {
  it("qualifies a bare name that the new place can no longer see", () => {
    const { ws, q3 } = setup();
    // On Q3 Budget a bare Rates reaches Plan's table through the parent scope.
    const content = ws.getPage(q3).content;
    ws.dispatch("setCell", {
      pageId: q3,
      tableId: content.tableOrder[0],
      col: 0,
      row: 0,
      cell: { formula: "=Rates!A1" }
    });
    ws.dispatch("movePage", { pageId: q3, newParentId: null });
    const moved = ws.getPage(q3).content.tables[content.tableOrder[0]].cells["0,0"].formula;
    expect(moved).toBe("=Plan!Rates!A1");
  });

  it("leaves references alone when they still resolve to the same thing", () => {
    const { ws, plan, report, formula, read } = setup();
    formula("0,0", "=Plan!Costs!A1");
    ws.dispatch("movePage", { pageId: report, newParentId: plan });
    // Plan is now the parent: a bare "Costs" would work but the text still resolves, so it stays.
    expect(read("0,0")).toBe("=Plan!Costs!A1");
  });
});

describe("a new page that would capture a bare name", () => {
  it("respells existing bare references to keep their target", () => {
    const { ws, q3, ids } = setup();
    ws.dispatch("setCell", {
      pageId: q3,
      tableId: ids.q3Costs,
      col: 0,
      row: 0,
      cell: { formula: "=Rates!A1" }
    });
    // A page called Rates under Q3 Budget would be found first from Q3 Budget.
    ws.dispatch("createPage", { type: "sheet", title: "Rates", parentId: q3 });
    const text = ws.getPage(q3).content.tables[ids.q3Costs].cells["0,0"].formula;
    expect(text).toBe("=Plan!Rates!A1");
  });
});

describe("retargetReferences", () => {
  it("does nothing, and reports zero, when no formula names anything", () => {
    const { ws, formula } = setup();
    formula("0,0", "=A1+SUM(B1:B3)");
    const snapshot = snapshotReferences(ws._data);
    expect(snapshot.entries).toHaveLength(0);
    expect(retargetReferences(ws._data, snapshot)).toBe(0);
  });

  it("leaves unresolved names alone", () => {
    const { ws, plan, ids, formula, read } = setup();
    formula("0,0", "=Plan!Nope!A1");
    ws.dispatch("renameTable", { pageId: plan, tableId: ids.planRates, name: "Fees" });
    expect(read("0,0")).toBe("=Plan!Nope!A1");
  });
});
