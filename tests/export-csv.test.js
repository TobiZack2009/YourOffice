import { describe, expect, it } from "vitest";
import { tableRows, toCsv } from "../src/export/csv.js";
import { exportFixture } from "./export-fixture.js";
import { enginesFor } from "../src/export/static-render.js";

describe("toCsv", () => {
  it("separates with commas and ends rows with CRLF", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });

  it("quotes fields that hold commas, quotes or line breaks", () => {
    expect(toCsv([["a,b", 'say "hi"', "x\ny", "plain"]])).toBe('"a,b","say ""hi""","x\ny",plain\r\n');
  });

  it("is empty for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("tableRows", () => {
  const table = (cells, extra = {}) => ({ columnCount: 5, rowCount: 5, cells, ...extra });
  const engines = { display: (t, col, row) => String(t.cells[`${col},${row}`]?.value ?? "") };

  it("trims to the used extent", () => {
    const rows = tableRows(table({ "0,0": { value: "a" }, "2,1": { value: "b" } }), engines);
    expect(rows).toEqual([["a", "", ""], ["", "", "b"]]);
  });

  it("is empty for an empty table", () => {
    expect(tableRows(table({}), engines)).toEqual([]);
  });

  it("limits to a range", () => {
    const t = table({ "0,0": { value: "a" }, "1,1": { value: "b" }, "2,2": { value: "c" } });
    expect(tableRows(t, engines, { start: { col: 1, row: 1 }, end: { col: 2, row: 2 } })).toEqual([["b", ""], ["", "c"]]);
  });

  it("shows what the sheet shows: a formula holds its result", () => {
    const { ws, data, costs } = exportFixture();
    const t = ws.getPage(data).content.tables[costs];
    expect(tableRows(t, enginesFor(ws.data))).toEqual([["5", "10"], ["7", ""]]);
  });
});
