import { describe, expect, it } from "vitest";
import { ERR, FormulaError, errorFromLiteral, isFormulaError, explain, withDetail, withOrigin } from "../src/sheet/errors.js";

describe("FormulaError", () => {
  it("stringifies to its code", () => {
    expect(String(ERR.DIV0)).toBe("#DIV/0!");
    expect(new FormulaError("#REF!").code).toBe("#REF!");
  });

  it("is recognised by isFormulaError", () => {
    expect(isFormulaError(ERR.NA)).toBe(true);
    expect(isFormulaError("#N/A")).toBe(false);
    expect(isFormulaError(null)).toBe(false);
  });

  it("parses error literals", () => {
    expect(errorFromLiteral("#REF!")?.code).toBe("#REF!");
    expect(errorFromLiteral("#DIV/0!")?.code).toBe("#DIV/0!");
    expect(errorFromLiteral("#bogus")).toBeNull();
  });

  it("exposes the standard Excel error codes", () => {
    const codes = new Set(Object.values(ERR).map((error) => error.code));
    for (const code of ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#NUM!", "#N/A"]) {
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe("error explanations", () => {
  it("gives every code a generic message and hint", () => {
    for (const error of Object.values(ERR)) {
      const info = explain(error);
      expect(info.message.length).toBeGreaterThan(10);
      expect(info.hint.length).toBeGreaterThan(5);
      expect(info.text).toContain(info.message);
    }
  });

  it("derives an error with the same code and a specific detail", () => {
    const derived = withDetail(ERR.NAME, 'Nothing is named "Totl". Did you mean "Total"?');
    expect(derived).not.toBe(ERR.NAME);
    expect(derived.code).toBe("#NAME?");
    expect(isFormulaError(derived)).toBe(true);
    expect(explain(derived).text).toContain("Did you mean");
    expect(ERR.NAME.detail).toBeNull();
  });

  it("notes the origin of a propagated error once", () => {
    const first = withOrigin(ERR.DIV0, "Expenses!B2");
    expect(first.code).toBe("#DIV/0!");
    expect(first.origin).toBe("Expenses!B2");
    expect(first.detail).toContain("Expenses!B2");
    expect(withOrigin(first, "Other!A1")).toBe(first);
  });
});
