import { describe, expect, it } from "vitest";
import { ERR, FormulaError, errorFromLiteral, isFormulaError } from "../src/sheet/errors.js";

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
