/**
 * Sheets as CSV (RFC 4180): one file per table, showing what the sheet shows, so a formula
 * cell holds its result. A merged range holds its value in the top-left cell and is empty
 * elsewhere, as in the grid.
 */

/**
 * @param {string} field
 * @returns {string}
 */
function quote(field) {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * @param {string[][]} rows
 * @returns {string} Every row ends with CRLF.
 */
export function toCsv(rows) {
  return rows.map((row) => row.map(quote).join(",") + "\r\n").join("");
}

/**
 * The cells of a table that hold something, as rows of display text from the top left down to
 * the last used row and column. A range limits it to a rectangle.
 * @param {import("../calc/model.js").Table} table
 * @param {{ display: (table: any, col: number, row: number) => string }} engines
 * @param {{ start: { col: number, row: number }, end: { col: number, row: number } }} [range] 0-based, inclusive.
 * @returns {string[][]}
 */
export function tableRows(table, engines, range) {
  const firstCol = range?.start.col ?? 0;
  const firstRow = range?.start.row ?? 0;
  const lastCol = Math.min(range?.end.col ?? table.columnCount - 1, table.columnCount - 1);
  const lastRow = Math.min(range?.end.row ?? table.rowCount - 1, table.rowCount - 1);
  /** @type {string[][]} */
  const rows = [];
  let usedRows = 0;
  let usedCols = 0;
  for (let row = firstRow; row <= lastRow; row++) {
    /** @type {string[]} */
    const line = [];
    for (let col = firstCol; col <= lastCol; col++) {
      const text = engines.display(table, col, row);
      line.push(text);
      if (text !== "") {
        usedRows = Math.max(usedRows, row - firstRow + 1);
        usedCols = Math.max(usedCols, col - firstCol + 1);
      }
    }
    rows.push(line);
  }
  return rows.slice(0, usedRows).map((line) => line.slice(0, usedCols));
}
