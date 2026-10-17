import { describe, expect, it } from "vitest";
import { parseFormula } from "../src/sheet/parser.js";
import { FormulaSyntaxError } from "../src/sheet/tokenizer.js";

describe("parseFormula — literals and references", () => {
  it("parses scalars", () => {
    expect(parseFormula("42")).toEqual({ type: "number", value: 42 });
    expect(parseFormula('"hi"')).toEqual({ type: "string", value: "hi" });
    expect(parseFormula("TRUE")).toEqual({ type: "boolean", value: true });
    expect(parseFormula("#REF!")).toEqual({ type: "error", code: "#REF!" });
  });

  it("parses cell references, keeping absolute markers", () => {
    expect(parseFormula("A1")).toEqual({
      type: "ref",
      ref: { col: 1, row: 1, absCol: false, absRow: false }
    });
    expect(parseFormula("$B$2")).toEqual({
      type: "ref",
      ref: { col: 2, row: 2, absCol: true, absRow: true }
    });
  });

  it("parses ranges", () => {
    const ast = parseFormula("A1:B2");
    expect(ast.type).toBe("range");
    expect(ast.start.col).toBe(1);
    expect(ast.end.row).toBe(2);
  });

  it("treats identifier-looking references as references", () => {
    // "SUM1" is column SUM, row 1 — a valid reference, not a name.
    expect(parseFormula("SUM1").type).toBe("ref");
  });

  it("parses bare names", () => {
    expect(parseFormula("project.summary")).toEqual({
      type: "name",
      name: "project.summary"
    });
  });
});

describe("parseFormula — operators", () => {
  it("applies standard precedence", () => {
    const ast = parseFormula("1+2*3");
    expect(ast.type).toBe("binary");
    expect(ast.op).toBe("+");
    expect(ast.left).toEqual({ type: "number", value: 1 });
    expect(ast.right.op).toBe("*");
  });

  it("gives unary minus higher precedence than exponent (Excel rule)", () => {
    const ast = parseFormula("-2^2");
    expect(ast.op).toBe("^");
    expect(ast.left).toEqual({ type: "unary", op: "-", operand: { type: "number", value: 2 } });
  });

  it("makes exponent right-associative", () => {
    const ast = parseFormula("2^3^2");
    expect(ast.op).toBe("^");
    expect(ast.left).toEqual({ type: "number", value: 2 });
    expect(ast.right.op).toBe("^");
  });

  it("makes subtraction left-associative", () => {
    const ast = parseFormula("10-3-2");
    expect(ast.op).toBe("-");
    expect(ast.left.op).toBe("-");
    expect(ast.right).toEqual({ type: "number", value: 2 });
  });

  it("honours parentheses", () => {
    const ast = parseFormula("(1+2)*3");
    expect(ast.op).toBe("*");
    expect(ast.left.op).toBe("+");
  });

  it("parses comparison, concat and percent", () => {
    expect(parseFormula("1<=2").op).toBe("<=");
    expect(parseFormula('"a"&"b"').op).toBe("&");
    const pct = parseFormula("50%");
    expect(pct.type).toBe("postfix");
    expect(pct.op).toBe("%");
  });
});

describe("parseFormula — function calls", () => {
  it("parses calls with arguments", () => {
    const ast = parseFormula("SUM(A1:A3, 2)");
    expect(ast.type).toBe("call");
    expect(ast.name).toBe("SUM");
    expect(ast.args).toHaveLength(2);
    expect(ast.args[0].type).toBe("range");
    expect(ast.args[1]).toEqual({ type: "number", value: 2 });
  });

  it("uppercases function names", () => {
    expect(parseFormula("sum(1)").name).toBe("SUM");
  });

  it("supports zero arguments", () => {
    expect(parseFormula("NOW()").args).toEqual([]);
  });

  it("supports omitted arguments", () => {
    const ast = parseFormula("IF(A1,,3)");
    expect(ast.args[1]).toEqual({ type: "empty" });
  });

  it("supports nested calls", () => {
    const ast = parseFormula("SUM(MAX(1,2), MIN(3,4))");
    expect(ast.args[0].name).toBe("MAX");
    expect(ast.args[1].name).toBe("MIN");
  });
});

describe("parseFormula — errors", () => {
  it("rejects trailing junk", () => {
    expect(() => parseFormula("1 2")).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("A1 B2")).toThrow(FormulaSyntaxError);
  });

  it("rejects unbalanced parentheses", () => {
    expect(() => parseFormula("(1+2")).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("SUM(1,2")).toThrow(FormulaSyntaxError);
  });

  it("rejects malformed ranges", () => {
    expect(() => parseFormula("A1:")).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("A1:B")).toThrow(FormulaSyntaxError);
  });

  it("rejects a leading binary operator", () => {
    expect(() => parseFormula("*3")).toThrow(FormulaSyntaxError);
  });

  it("reports a source position", () => {
    try {
      parseFormula("1+*2");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaSyntaxError);
      expect(/** @type {FormulaSyntaxError} */ (error).position).toBeGreaterThan(0);
    }
  });
});
