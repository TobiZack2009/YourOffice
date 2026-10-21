import { describe, expect, it } from "vitest";
import { parseFormula } from "../src/calc/parser.js";
import { evaluate, displayValue } from "../src/calc/evaluator.js";
import { ERR, isFormulaError } from "../src/calc/errors.js";
import { FUNCTION_NAMES, formatWithPattern } from "../src/calc/functions.js";
import { makeRange, rangeDims } from "../src/calc/values.js";
import { formatName, isPlainName, nameProblem } from "../src/calc/names.js";

function run(text, cells = {}, extra = {}) {
  const context = {
    getCell: (ref) => cells[`${ref.col},${ref.row}`] ?? null,
    getRange: (start, end) => {
      const values = [];
      for (let row = start.row; row <= end.row; row++) {
        for (let col = start.col; col <= end.col; col++) values.push(cells[`${col},${row}`] ?? null);
      }
      return values;
    },
    ...extra
  };
  return evaluate(parseFormula(text), context);
}

describe("logic functions", () => {
  it("AND / OR / NOT", () => {
    expect(run("AND(TRUE, 1, A1>0)", { "1,1": 3 })).toBe(true);
    expect(run("AND(TRUE, FALSE)")).toBe(false);
    expect(run("OR(FALSE, 0)")).toBe(false);
    expect(run("OR(FALSE, 2)")).toBe(true);
    expect(run("NOT(FALSE)")).toBe(true);
    expect(run('AND("x")').code).toBe("#VALUE!");
  });

  it("AND ignores text and blanks inside ranges", () => {
    expect(run("AND(A1:A3)", { "1,1": true, "1,2": "note" })).toBe(true);
    expect(run("OR(A1:A2)", {})).toEqual(ERR.VALUE);
  });

  it("IFERROR and IFNA are lazy and only catch what they should", () => {
    expect(run("IFERROR(1/0, 0)")).toBe(0);
    expect(run("IFERROR(5, 1/0)")).toBe(5);
    expect(run("IFNA(#N/A, 7)")).toBe(7);
    expect(run("IFNA(1/0, 7)")).toBe(ERR.DIV0);
  });

  it("IS* predicates", () => {
    expect(run("ISBLANK(A1)")).toBe(true);
    expect(run("ISBLANK(A1)", { "1,1": 0 })).toBe(false);
    expect(run("ISERROR(1/0)")).toBe(true);
    expect(run("ISERROR(1)")).toBe(false);
    expect(run("ISNUMBER(3)")).toBe(true);
    expect(run('ISNUMBER("3")')).toBe(false);
    expect(run('ISTEXT("a")')).toBe(true);
  });

  it("IF passes handles through untouched", () => {
    const handle = { kind: "blocks", sectionId: "sec_1" };
    const ctx = { resolvePath: (segments) => (segments[0] === "Notes" ? handle : undefined) };
    expect(run("IF(TRUE, Notes, \"\")", {}, ctx)).toBe(handle);
    expect(run("IF(FALSE, Notes, \"\")", {}, ctx)).toBe("");
  });
});

describe("math functions", () => {
  it("rounds half away from zero and survives binary noise", () => {
    expect(run("ROUND(2.5)")).toBe(3);
    expect(run("ROUND(-2.5)")).toBe(-3);
    expect(run("ROUND(1.005, 2)")).toBe(1.01);
    expect(run("ROUND(1234, -2)")).toBe(1200);
    expect(run("ROUNDUP(2.1)")).toBe(3);
    expect(run("ROUNDUP(-2.1)")).toBe(-3);
    expect(run("ROUNDDOWN(2.9)")).toBe(2);
    expect(run("ROUNDDOWN(-2.9)")).toBe(-2);
    expect(Object.is(run("ROUND(-0.2)"), -0)).toBe(false);
  });

  it("ABS INT MOD SQRT POWER", () => {
    expect(run("ABS(-3)")).toBe(3);
    expect(run("INT(-1.5)")).toBe(-2);
    expect(run("MOD(7, 3)")).toBe(1);
    expect(run("MOD(-7, 3)")).toBe(2);
    expect(run("MOD(1, 0)")).toBe(ERR.DIV0);
    expect(run("SQRT(16)")).toBe(4);
    expect(run("SQRT(-1)").code).toBe("#NUM!");
    expect(run("POWER(2, 10)")).toBe(1024);
    expect(run("POWER(0, -1)")).toBe(ERR.DIV0);
  });
});

describe("text functions", () => {
  it("LEN UPPER LOWER TRIM", () => {
    expect(run('LEN("hello")')).toBe(5);
    expect(run('UPPER("ab")')).toBe("AB");
    expect(run('LOWER("AB")')).toBe("ab");
    expect(run('TRIM("  a   b ")')).toBe("a b");
  });

  it("LEFT RIGHT MID", () => {
    expect(run('LEFT("hello", 2)')).toBe("he");
    expect(run('LEFT("hello")')).toBe("h");
    expect(run('RIGHT("hello", 3)')).toBe("llo");
    expect(run('RIGHT("hello", 0)')).toBe("");
    expect(run('MID("hello", 2, 3)')).toBe("ell");
    expect(run('MID("hello", 0, 3)')).toEqual(ERR.VALUE);
  });

  it("FIND is case-sensitive, SEARCH is not, both explain a miss", () => {
    expect(run('FIND("l", "hello")')).toBe(3);
    expect(run('FIND("L", "hello")').code).toBe("#VALUE!");
    expect(run('SEARCH("L", "hello")')).toBe(3);
    expect(run('FIND("l", "hello", 4)')).toBe(4);
    expect(run('FIND("z", "hello")').detail).toContain("was not found");
  });

  it("REPLACE is positional, SUBSTITUTE is by text", () => {
    expect(run('REPLACE("abcdef", 2, 3, "-")')).toBe("a-ef");
    expect(run('SUBSTITUTE("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(run('SUBSTITUTE("a-b-c", "-", "+", 2)')).toBe("a-b+c");
  });

  it("INCLUDES STARTSWITH ENDSWITH ignore case", () => {
    expect(run('INCLUDES("Hello World", "WORLD")')).toBe(true);
    expect(run('STARTSWITH("Hello", "he")')).toBe(true);
    expect(run('ENDSWITH("Hello", "LO")')).toBe(true);
    expect(run('ENDSWITH("Hello", "x")')).toBe(false);
  });

  it("TEXT formats with a small pattern language", () => {
    expect(formatWithPattern(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(formatWithPattern(0.256, "0%")).toBe("26%");
    expect(formatWithPattern(0.256, "0.0%")).toBe("25.6%");
    expect(formatWithPattern(5, "0000")).toBe("0005");
    expect(formatWithPattern(1234, "$#,##0")).toBe("$1,234");
    expect(formatWithPattern(-3.14159, "0.00")).toBe("-3.14");
    expect(run('TEXT(1234.5, "#,##0.0")')).toBe("1,234.5");
    expect(run('TEXT("abc", "0.00")')).toBe("abc");
  });
});

describe("values and handles", () => {
  it("collapses a 1x1 range and carries shape on larger ones", () => {
    expect(run("A1:A1", { "1,1": 4 })).toBe(4);
    const range = run("A1:B2", { "1,1": 1, "2,1": 2, "1,2": 3, "2,2": 4 });
    expect(Array.isArray(range)).toBe(true);
    expect([...range]).toEqual([1, 2, 3, 4]);
    expect(rangeDims(range)).toEqual({ rows: 2, cols: 2 });
    expect(Object.keys(range)).toEqual(["0", "1", "2", "3"]);
    expect(rangeDims(makeRange([1, 2, 3], 1, 3))).toEqual({ rows: 1, cols: 3 });
  });

  it("coerces a blocks handle to plain text for operators and functions", () => {
    const handle = { kind: "blocks", sectionId: "sec_1" };
    const ctx = {
      resolvePath: () => handle,
      handleText: () => "Net income 42"
    };
    expect(run('Notes & "!"', {}, ctx)).toBe("Net income 42!");
    expect(run('INCLUDES(Notes, "income")', {}, ctx)).toBe(true);
    expect(run('Notes = "net income 42"', {}, ctx)).toBe(true);
    expect(run("LEN(Notes)", {}, ctx)).toBe(13);
  });

  it("rejects slides, tables and ranges in arithmetic and comparison", () => {
    const slide = { kind: "slide", sectionId: "sec_s" };
    const ctx = { resolvePath: (s) => (s[0] === "Slide" ? slide : makeRange([1, 2], 1, 2)) };
    expect(run("Slide + 1", {}, ctx).code).toBe("#VALUE!");
    expect(run("Slide = 1", {}, ctx)).toBeDefined();
    expect(isFormulaError(run("Slide = 1", {}, ctx))).toBe(true);
    expect(run("Table + 1", {}, ctx).code).toBe("#VALUE!");
    expect(run("Table = 1", {}, ctx).code).toBe("#VALUE!");
    expect(run("Slide & \"x\"", {}, ctx).code).toBe("#VALUE!");
  });

  it("evaluates names and paths through resolvePath", () => {
    const seen = [];
    const ctx = {
      resolvePath: (segments, address) => {
        seen.push([segments, address?.type ?? null]);
        return 9;
      }
    };
    expect(run("Total", {}, ctx)).toBe(9);
    expect(run("Plan!Costs!B2", {}, ctx)).toBe(9);
    expect(seen).toEqual([[["Total"], null], [["Plan", "Costs"], "ref"]]);
  });

  it("explains an unresolved name", () => {
    const error = run("Missing", {}, { resolvePath: () => undefined });
    expect(error.code).toBe("#NAME?");
    expect(error.detail).toContain("Missing");
    expect(run("A!B", {}, { resolvePath: () => undefined }).detail).toContain("A!B");
  });

  it("REF reads by stable id", () => {
    const ctx = { resolveId: (id) => (id === "sec_1" ? 5 : undefined) };
    expect(run('REF("sec_1") + 1', {}, ctx)).toBe(6);
    expect(run('REF("nope")', {}, ctx).code).toBe("#NAME?");
    expect(run("REF(1)", {}, ctx).code).toBe("#VALUE!");
    expect(run('REF("x")').code).toBe("#NAME?");
  });

  it("displays handles as #VALUE!", () => {
    expect(displayValue({ kind: "slide", sectionId: "s" })).toBe("#VALUE!");
  });
});

describe("function table", () => {
  it("lists every spec function", () => {
    for (const name of [
      "SUM", "AVERAGE", "MIN", "MAX", "COUNT", "CONCAT", "IF", "IFERROR", "IFNA", "AND", "OR", "NOT",
      "ISBLANK", "ISERROR", "ISNUMBER", "ISTEXT", "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "INT", "MOD",
      "SQRT", "POWER", "LEN", "UPPER", "LOWER", "TRIM", "LEFT", "RIGHT", "MID", "FIND", "SEARCH",
      "REPLACE", "SUBSTITUTE", "TEXT", "INCLUDES", "STARTSWITH", "ENDSWITH", "REF"
    ]) {
      expect(FUNCTION_NAMES).toContain(name);
    }
  });
});

describe("name syntax", () => {
  it("writes plain names bare and others quoted", () => {
    expect(formatName("Expenses")).toBe("Expenses");
    expect(formatName("Q3 Budget")).toBe("'Q3 Budget'");
    expect(formatName("It's")).toBe("'It''s'");
    expect(formatName("A1")).toBe("'A1'");
    expect(isPlainName("q3.total")).toBe(true);
  });

  it("explains unusable names", () => {
    expect(nameProblem("")).toMatch(/empty/);
    expect(nameProblem("B2")).toMatch(/cell reference/);
    expect(nameProblem("true")).toMatch(/reserved/);
    expect(nameProblem("SUM(x)")).toMatch(/call to SUM/);
    expect(nameProblem(" pad")).toMatch(/space/);
    expect(nameProblem("Q3 Budget")).toBeNull();
    expect(nameProblem("SUM")).toBeNull();
  });
});
