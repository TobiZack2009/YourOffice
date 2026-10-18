import { describe, expect, it } from "vitest";
import {
  closestName,
  collectNames,
  formatPath,
  membersOf,
  nameTaken,
  qualifyToKeepTarget,
  resolveTarget,
  scopeChain,
  uniqueName
} from "../src/references/scope.js";
import { parseFormula } from "../src/sheet/parser.js";

/**
 * Plan (sheet: Costs, Rates)
 *   Q3 Budget (sheet: Costs, section "Summary")
 *   Notes (document, section "Summary")
 * Archive
 *   Notes (document)
 */
function fixture() {
  const sheet = (id, title, names) => ({
    id,
    type: "sheet",
    title,
    content: {
      tables: Object.fromEntries(names.map((n) => [`t_${id}_${n}`, { id: `t_${id}_${n}`, name: n, cells: {} }])),
      tableOrder: names.map((n) => `t_${id}_${n}`)
    }
  });
  const pages = {
    plan: sheet("plan", "Plan", ["Costs", "Rates"]),
    q3: sheet("q3", "Q3 Budget", ["Costs"]),
    notes: { id: "notes", type: "document", title: "Notes", content: { blockOrder: [], blocks: {} } },
    archive: { id: "archive", type: "document", title: "Archive" },
    old: { id: "old", type: "document", title: "Notes", content: { blockOrder: [], blocks: {} } }
  };
  pages.q3.content.sections = { sec_sum: { id: "sec_sum", name: "Summary", locator: {} } };
  pages.notes.content.sections = {
    sec_a: { id: "sec_a", name: "Summary", locator: {} },
    sec_hidden: { id: "sec_hidden", locator: {}, implicit: true }
  };
  return {
    pages,
    pageOrder: { root: ["plan", "notes", "archive"], plan: ["q3"], archive: ["old"] }
  };
}

describe("membersOf and scopeChain", () => {
  it("lists tables, named sections and child pages; skips unnamed sections", () => {
    const data = fixture();
    expect(membersOf(data, "q3").map((m) => [m.kind, m.name])).toEqual([
      ["table", "Costs"],
      ["section", "Summary"]
    ]);
    expect(membersOf(data, "plan").map((m) => [m.kind, m.name])).toEqual([
      ["table", "Costs"],
      ["table", "Rates"],
      ["page", "Q3 Budget"]
    ]);
    expect(membersOf(data, null).map((m) => m.name)).toEqual(["Plan", "Notes", "Archive"]);
    expect(membersOf(data, "notes").map((m) => m.name)).toEqual(["Summary"]);
  });

  it("walks from the page out to the root", () => {
    expect(scopeChain(fixture(), "q3")).toEqual(["q3", "plan", null]);
    expect(scopeChain(fixture(), "archive")).toEqual(["archive", null]);
  });
});

describe("resolveTarget", () => {
  it("resolves bare names innermost-out, first match wins", () => {
    const data = fixture();
    expect(resolveTarget(data, "q3", ["Costs"]).target).toEqual({ kind: "table", pageId: "q3", tableId: "t_q3_Costs" });
    expect(resolveTarget(data, "plan", ["Costs"]).target?.tableId).toBe("t_plan_Costs");
    expect(resolveTarget(data, "q3", ["Rates"]).target?.tableId).toBe("t_plan_Rates");
  });

  it("is case-insensitive", () => {
    expect(resolveTarget(fixture(), "plan", ["costs"]).target?.tableId).toBe("t_plan_Costs");
  });

  it("resolves each path segment inside the previous page", () => {
    const data = fixture();
    expect(resolveTarget(data, "notes", ["Plan", "Costs"]).target?.tableId).toBe("t_plan_Costs");
    expect(resolveTarget(data, "notes", ["Plan", "Q3 Budget", "Costs"]).target?.tableId).toBe("t_q3_Costs");
    expect(resolveTarget(data, "notes", ["Q3 Budget", "Costs"]).error?.code).toBe("#NAME?");
  });

  it("resolves sections and pages", () => {
    const data = fixture();
    expect(resolveTarget(data, "notes", ["Summary"]).target).toEqual({ kind: "section", pageId: "notes", sectionId: "sec_a" });
    expect(resolveTarget(data, "plan", ["Q3 Budget", "Summary"]).target?.sectionId).toBe("sec_sum");
    expect(resolveTarget(data, "plan", ["Q3 Budget"]).target).toEqual({ kind: "page", pageId: "q3" });
  });

  it("gives #NAME? with a did-you-mean for an unknown name", () => {
    const miss = resolveTarget(fixture(), "plan", ["Cots"]);
    expect(miss.error?.code).toBe("#NAME?");
    expect(miss.error?.detail).toContain('"Cots"');
    expect(miss.error?.detail).toContain('Did you mean "Costs"?');
    const inner = resolveTarget(fixture(), "plan", ["Q3 Budget", "Cost"]);
    expect(inner.error?.detail).toContain('inside "Q3 Budget"');
    expect(inner.error?.detail).toContain('Did you mean "Costs"?');
  });

  it("reports an ambiguous page segment", () => {
    const data = fixture();
    data.pageOrder.root.push("old");
    data.pageOrder.archive = [];
    const result = resolveTarget(data, "plan", ["Notes"]);
    expect(result.ambiguous).toBe(true);
    expect(result.error?.code).toBe("#NAME?");
    expect(result.error?.detail).toContain("Several pages");
  });

  it("prefers a table or section over a page of the same name in one scope", () => {
    const data = fixture();
    data.pages.plan.content.tables.t_clash = { id: "t_clash", name: "Q3 Budget", cells: {} };
    data.pages.plan.content.tableOrder.push("t_clash");
    expect(resolveTarget(data, "plan", ["Q3 Budget"]).target?.kind).toBe("table");
    // ...but as a non-final segment only pages count.
    expect(resolveTarget(data, "plan", ["Q3 Budget", "Costs"]).target?.tableId).toBe("t_q3_Costs");
  });
});

describe("closestName", () => {
  it("suggests near misses and nothing for strangers", () => {
    const data = fixture();
    expect(closestName(data, "plan", "Rats")).toBe("Rates");
    expect(closestName(data, "plan", "zzzzzz")).toBeNull();
    expect(closestName(data, null, "Costz", { inside: "plan" })).toBe("Costs");
  });
});

describe("qualifyToKeepTarget", () => {
  it("keeps a bare name when it already resolves", () => {
    const data = fixture();
    const target = resolveTarget(data, "plan", ["Costs"]).target;
    expect(qualifyToKeepTarget(data, "plan", target)).toEqual(["Costs"]);
  });

  it("adds the page title when another table is closer", () => {
    const data = fixture();
    const target = resolveTarget(data, "plan", ["Costs"]).target;
    expect(qualifyToKeepTarget(data, "q3", target)).toEqual(["Plan", "Costs"]);
  });

  it("goes as deep as needed and quotes through formatPath", () => {
    const data = fixture();
    const target = resolveTarget(data, "plan", ["Q3 Budget", "Costs"]).target;
    expect(qualifyToKeepTarget(data, "notes", target)).toEqual(["Plan", "Q3 Budget", "Costs"]);
    expect(qualifyToKeepTarget(data, "plan", target)).toEqual(["Q3 Budget", "Costs"]);
    expect(formatPath(["Q3 Budget", "Costs"])).toBe("'Q3 Budget'!Costs");
  });

  it("returns null when nothing can tell duplicate pages apart", () => {
    const data = fixture();
    data.pageOrder.root.push("old");
    data.pageOrder.archive = [];
    expect(qualifyToKeepTarget(data, "plan", { kind: "page", pageId: "old" })).toBeNull();
  });
});

describe("unique names", () => {
  it("detects taken names across tables and sections", () => {
    const data = fixture();
    expect(nameTaken(data, "q3", "costs")).toBe(true);
    expect(nameTaken(data, "q3", "Summary")).toBe(true);
    expect(nameTaken(data, "q3", "Costs", "t_q3_Costs")).toBe(false);
    expect(nameTaken(data, "q3", "Rates")).toBe(false);
  });

  it("suffixes duplicates", () => {
    const data = fixture();
    expect(uniqueName(data, "plan", "Fresh")).toBe("Fresh");
    expect(uniqueName(data, "plan", "Costs")).toBe("Costs 2");
    data.pages.plan.content.tables.t_x = { id: "t_x", name: "Costs 2", cells: {} };
    data.pages.plan.content.tableOrder.push("t_x");
    expect(uniqueName(data, "plan", "Costs")).toBe("Costs 3");
    expect(uniqueName(data, "plan", "Costs 2")).toBe("Costs 3");
  });
});

describe("collectNames", () => {
  it("lists bare names and paths in source order", () => {
    const names = collectNames(parseFormula("SUM(Costs) + Plan!Rates!B2 + IF(A1, 'Q3 Budget'!Summary, \"\")"));
    expect(names.map((n) => n.segments)).toEqual([["Costs"], ["Plan", "Rates"], ["Q3 Budget", "Summary"]]);
    expect(names[1].address?.type).toBe("ref");
    expect(names[0].address).toBeNull();
  });
});
