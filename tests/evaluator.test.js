import { describe, expect, it } from "vitest";
import { parseFormula } from "../src/calc/parser.js";
import { evaluate, displayValue } from "../src/calc/evaluator.js";
import { ERR } from "../src/calc/errors.js";

/**
 * Evaluate formula text against a sparse cell map keyed "col,row".
 * @param {string} text
 * @param {Record<string, import("../src/calc/values.js").Value>} [cells]
 */
function run(text, cells = {}) {
  const context = {
    getCell: (ref) => {
      const key = `${ref.col},${ref.row}`;
      return key in cells ? cells[key] : null;
    },
    getRange: (start, end) => {
      const values = [];
      for (let row = start.row; row <= end.row; row++) {
        for (let col = start.col; col <= end.col; col++) {
          const key = `${col},${row}`;
          values.push(key in cells ? cells[key] : null);
        }
      }
      return values;
    }
  };
  return evaluate(parseFormula(text), context);
}

describe("evaluate — literals and references", () => {
  it("evaluates scalars", () => {
    expect(run("42")).toBe(42);
    expect(run('"hi"')).toBe("hi");
    expect(run("TRUE")).toBe(true);
  });

  it("reads cells, blanks behaving as null", () => {
    expect(run("A1", { "1,1": 7 })).toBe(7);
    expect(run("B2", { "1,1": 7 })).toBe(null);
  });

  it("propagates error literals", () => {
    expect(run("#REF!")).toBe(ERR.REF);
  });

  it("returns #NAME? for unresolved names", () => {
    expect(run("project.summary")).toBe(ERR.NAME);
  });

  it("resolves names via the context", () => {
    const ast = parseFormula("my.value");
    const value = evaluate(ast, {
      getCell: () => null,
      getRange: () => [],
      getName: (name) => (name === "my.value" ? 5 : undefined)
    });
    expect(value).toBe(5);
  });
});

describe("evaluate — arithmetic", () => {
  it("respects precedence", () => {
    expect(run("1+2*3")).toBe(7);
    expect(run("(1+2)*3")).toBe(9);
  });

  it("matches Excel for unary minus with exponent", () => {
    expect(run("-2^2")).toBe(4);
    expect(run("0-2^2")).toBe(-4);
  });

  it("treats exponent as right-associative", () => {
    expect(run("2^3^2")).toBe(512);
  });

  it("coerces blanks, booleans and numeric text", () => {
    expect(run("A1+1", { "1,1": null })).toBe(1);
    expect(run("TRUE+1")).toBe(2);
    expect(run('"3"*2')).toBe(6);
  });

  it("returns #VALUE! for non-numeric text", () => {
    expect(run('"abc"+1')).toBe(ERR.VALUE);
  });

  it("returns #DIV/0! on division by zero", () => {
    expect(run("1/0")).toBe(ERR.DIV0);
    expect(run("0/0")).toBe(ERR.DIV0);
  });

  it("returns #NUM! for numeric overflow", () => {
    expect(run("1e308*10")).toBe(ERR.NUM);
  });

  it("applies percent as divide-by-100", () => {
    expect(run("50%")).toBe(0.5);
    expect(run("200*10%")).toBe(20);
  });
});

describe("evaluate — text and comparison", () => {
  it("concatenates with &", () => {
    expect(run('"a"&"b"')).toBe("ab");
    expect(run('"n="&42')).toBe("n=42");
    expect(run('"b"&TRUE')).toBe("bTRUE");
    expect(run('"x"&A1', { "1,1": null })).toBe("x");
  });

  it("compares numbers", () => {
    expect(run("1<2")).toBe(true);
    expect(run("2<=2")).toBe(true);
    expect(run("3<>3")).toBe(false);
    expect(run("3=3")).toBe(true);
  });

  it("compares text case-insensitively", () => {
    expect(run('"abc"="ABC"')).toBe(true);
    expect(run('"abc"<"abd"')).toBe(true);
  });

  it("coerces numeric text when compared with numbers", () => {
    expect(run('"5"=5')).toBe(true);
    expect(run('"5"<"abc"')).toBe(true);
    // Excel orders every number below any non-numeric text
    expect(run('"abc">5')).toBe(true);
    expect(run('"abc"<5')).toBe(false);
  });
});

describe("evaluate — functions", () => {
  it("SUM ignores text and blanks in ranges, coerces scalars", () => {
    expect(run("SUM(1,2,3)")).toBe(6);
    expect(run("SUM(A1:A3)", { "1,1": 1, "1,2": "text", "1,3": 2 })).toBe(3);
    expect(run("SUM(A1:A2)", { "1,1": true, "1,2": null })).toBe(0);
    expect(run('SUM("5",1)')).toBe(6);
    expect(run('SUM("x")')).toBe(ERR.VALUE);
  });

  it("SUM propagates errors", () => {
    expect(run("SUM(A1:A2)", { "1,1": 1, "1,2": ERR.DIV0 })).toBe(ERR.DIV0);
  });

  it("AVERAGE divides by numeric count and guards zero", () => {
    expect(run("AVERAGE(2,4,6)")).toBe(4);
    expect(run("AVERAGE(A1:A2)", { "1,1": "x", "1,2": null })).toBe(ERR.DIV0);
  });

  it("MIN and MAX over numbers", () => {
    expect(run("MIN(3,1,2)")).toBe(1);
    expect(run("MAX(3,1,2)")).toBe(3);
    expect(run("MIN(A1:A2)", { "1,1": "x", "1,2": null })).toBe(0);
  });

  it("COUNT counts numbers only, ignoring range text and errors", () => {
    expect(run("COUNT(1,2,3)")).toBe(3);
    expect(run("COUNT(A1:A3)", { "1,1": 1, "1,2": "x", "1,3": null })).toBe(1);
    expect(run('COUNT("5")')).toBe(1);
    expect(run('COUNT("x")')).toBe(0);
  });

  it("CONCAT joins text", () => {
    expect(run('CONCAT("a",1,TRUE)')).toBe("a1TRUE");
    expect(run("CONCAT(A1:A2)", { "1,1": "x", "1,2": "y" })).toBe("xy");
  });

  it("IF evaluates lazily and only the taken branch", () => {
    expect(run("IF(TRUE,1,2)")).toBe(1);
    expect(run("IF(FALSE,1,2)")).toBe(2);
    expect(run("IF(1/0,1,2)")).toBe(ERR.DIV0);
    expect(run("IF(TRUE,1,1/0)")).toBe(1);
    expect(run("IF(FALSE,1/0,2)")).toBe(2);
    expect(run("IF(FALSE,1)")).toBe(false);
  });

  it("nested calls compose", () => {
    expect(run("SUM(MAX(1,2),MIN(3,4))")).toBe(5);
  });

  it("unknown functions are #NAME?", () => {
    expect(run("NOPE(1)").code).toBe(ERR.NAME.code);
    expect(run("NOPE()")).toMatchObject({ code: "#NAME?", detail: '"NOPE" is not a function.' });
  });

  it("rejects wrong argument counts with #VALUE!", () => {
    expect(run("SUM()").code).toBe(ERR.VALUE.code);
    expect(run("IF(TRUE)")).toBe(ERR.VALUE);
    expect(run("ROUND(1,2,3)").detail).toBe("ROUND takes 1 to 2 arguments but was given 3.");
  });
});

describe("displayValue", () => {
  it("formats scalars and errors", () => {
    expect(displayValue(42)).toBe("42");
    expect(displayValue(0.5)).toBe("0.5");
    expect(displayValue(0.1 + 0.2)).toBe("0.3");
    expect(displayValue(true)).toBe("TRUE");
    expect(displayValue(null)).toBe("");
    expect(displayValue("x")).toBe("x");
    expect(displayValue(ERR.DIV0)).toBe("#DIV/0!");
  });
});
