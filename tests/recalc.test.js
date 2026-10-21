import { describe, expect, it } from "vitest";
import { RecalcEngine, collectReferences } from "../src/calc/recalc.js";
import { parseA1 } from "../src/calc/references.js";
import { parseFormula } from "../src/calc/parser.js";
import { ERR } from "../src/calc/errors.js";

/** @param {string} a1 */
const at = (a1) => /** @type {import("../src/calc/references.js").CellRef} */ (parseA1(a1));

describe("RecalcEngine — basics", () => {
  it("evaluates literals and formulas", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 1);
    engine.setFormula(at("B1"), "=A1+1");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(2);
    expect(engine.getDisplay(at("B1"))).toBe("2");
  });

  it("resolves forward references regardless of definition order", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("B1"), "=A1*2");
    engine.setLiteral(at("A1"), 5);
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(10);
  });

  it("evaluates chains in dependency order", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("C1"), "=B1+1");
    engine.setFormula(at("B1"), "=A1+1");
    engine.setLiteral(at("A1"), 1);
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(2);
    expect(engine.getValue(at("C1"))).toBe(3);
  });

  it("sums ranges", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 1);
    engine.setLiteral(at("A2"), 2);
    engine.setLiteral(at("A3"), 3);
    engine.setFormula(at("B1"), "=SUM(A1:A3)");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(6);
  });

  it("keeps blank cells as null and coerces in arithmetic", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("B1"), "=A1+1");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(1);
  });

  it("exposes raw input, preserving formula text", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=1+2");
    engine.setLiteral(at("B1"), "text");
    expect(engine.getRaw(at("A1"))).toEqual({ kind: "formula", text: "=1+2" });
    expect(engine.getRaw(at("B1"))).toEqual({ kind: "literal", value: "text" });
    expect(engine.getRaw(at("C1"))).toBeUndefined();
  });
});

describe("RecalcEngine — incremental recalculation", () => {
  it("updates direct dependents after a change", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 1);
    engine.setFormula(at("B1"), "=A1+1");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(2);

    engine.setLiteral(at("A1"), 10);
    engine.recalculateDirty();
    expect(engine.getValue(at("B1"))).toBe(11);
  });

  it("updates range dependents after a change", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 1);
    engine.setLiteral(at("A2"), 2);
    engine.setFormula(at("B1"), "=SUM(A1:A2)");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(3);

    engine.setLiteral(at("A2"), 5);
    engine.recalculateDirty();
    expect(engine.getValue(at("B1"))).toBe(6);
  });

  it("propagates through dependence chains incrementally", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 1);
    engine.setFormula(at("B1"), "=A1+1");
    engine.setFormula(at("C1"), "=B1+1");
    engine.recalculate();

    engine.setLiteral(at("A1"), 5);
    engine.recalculateDirty();
    expect(engine.getValue(at("C1"))).toBe(7);
  });

  it("rebuilds edges when a formula's references change", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 1);
    engine.setLiteral(at("A2"), 100);
    engine.setFormula(at("B1"), "=A1");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(1);

    engine.setFormula(at("B1"), "=A2");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(100);

    // Changing the old precedent must no longer recalc B1.
    engine.setLiteral(at("A1"), 999);
    engine.recalculateDirty();
    expect(engine.getValue(at("B1"))).toBe(100);
  });

  it("recomputes dependents when a cell is cleared", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 5);
    engine.setFormula(at("B1"), "=A1+1");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(6);

    engine.clear(at("A1"));
    engine.recalculateDirty();
    expect(engine.getValue(at("B1"))).toBe(1);
  });
});

describe("RecalcEngine — errors and cycles", () => {
  it("propagates error values", () => {
    const engine = new RecalcEngine();
    engine.setLiteral(at("A1"), 0);
    engine.setFormula(at("B1"), "=1/A1");
    engine.recalculate();
    expect(engine.getValue(at("B1"))).toBe(ERR.DIV0);
  });

  it("stores malformed formulas as #ERROR! while keeping the text", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=1+");
    engine.recalculate();
    expect(engine.getValue(at("A1"))).toMatchObject({ code: "#ERROR!", position: 2 });
    expect(engine.getRaw(at("A1"))).toEqual({ kind: "formula", text: "=1+" });
  });

  it("detects a two-cell cycle", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=B1");
    engine.setFormula(at("B1"), "=A1");
    engine.recalculate();
    expect(engine.getValue(at("A1"))).toBe(ERR.CIRC);
    expect(engine.getValue(at("B1"))).toBe(ERR.CIRC);
  });

  it("detects a self-reference", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=A1+1");
    engine.recalculate();
    expect(engine.getValue(at("A1"))).toBe(ERR.CIRC);
  });

  it("detects a range that contains its own cell", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=SUM(A1:A2)");
    engine.recalculate();
    expect(engine.getValue(at("A1"))).toBe(ERR.CIRC);
  });

  it("marks cells downstream of a cycle as circular too", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=B1");
    engine.setFormula(at("B1"), "=A1");
    engine.setFormula(at("C1"), "=A1+1");
    engine.recalculate();
    expect(engine.getValue(at("C1"))).toBe(ERR.CIRC);
  });

  it("resolves a cycle once broken", () => {
    const engine = new RecalcEngine();
    engine.setFormula(at("A1"), "=B1");
    engine.setFormula(at("B1"), "=A1");
    engine.recalculate();
    expect(engine.getValue(at("A1"))).toBe(ERR.CIRC);

    engine.setFormula(at("B1"), "=1");
    engine.recalculate();
    expect(engine.getValue(at("A1"))).toBe(1);
  });
});

describe("collectReferences", () => {
  it("finds refs and rectangles", () => {
    const { refs, ranges } = collectReferences(parseFormula("A1+B2+SUM(C3:D4)"));
    expect(refs.map((ref) => `${ref.col},${ref.row}`).sort()).toEqual(["1,1", "2,2"]);
    expect(ranges).toEqual([{ start: { col: 3, row: 3 }, end: { col: 4, row: 4 } }]);
  });

  it("normalises reversed ranges", () => {
    const { ranges } = collectReferences(parseFormula("SUM(C4:A1)"));
    expect(ranges[0]).toEqual({ start: { col: 1, row: 1 }, end: { col: 3, row: 4 } });
  });
});
