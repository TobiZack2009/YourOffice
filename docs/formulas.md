# Formula engine and expression language

`src/calc/` (pure, dependency-free). One language serves sheet cells and cross-editor
expression references.

## Pipeline

`tokenize` -> `parseFormula` (AST) -> `evaluate` in a context. `RecalcEngine`
(`recalc.js`) owns the forward/reverse dependency graph, range rectangles, the dirty queue
(incremental recalculation), topological evaluation and cycle detection (self, two-node,
self-containing range, downstream).

## Lexical and grammar

- `tokenizer.js`: numbers (incl. exponent), strings (`""` escapes), booleans, error
  literals, words, operators, punctuation, `!`, `'quoted names'` (`''` escape), optional
  leading `=`. Every token has `end` (offset); `FormulaSyntaxError` carries positions.
- `parser.js`: recursive-descent precedence climbing. Excel precedence (`-2^2 = 4`),
  right-associative `^`, ranges, calls with omitted args, comparisons.
  `path := segment ("!" segment)* ("!" address)?`; `address := A1 | A1:A1` and is local to the
  target named before it. A `path` node has `segments` and an optional `address`; a single
  segment stays a `name` node. `REF("id")` is the stable-id form.
- Names cannot parse as A1, be TRUE/FALSE, or be a function name followed by `(`.

## Values and functions

- `values.js`: `toNumber/toText/toBoolean`, type-ordered comparison, number formatting.
  Values are scalars, ranges (arrays with non-enumerable `rows`/`cols`) and handles
  `{kind: "blocks"|"slide", sectionId}`. A 1x1 range collapses to a scalar. Block runs coerce
  to plain text for `&`, comparisons, `INCLUDES` and number parsing. Tables, ranges and slides
  in arithmetic or comparison give `#VALUE!`.
- `functions.js` is one table shared by sheets and expressions:
  SUM AVERAGE MIN MAX COUNT CONCAT; lazy IF IFERROR IFNA; AND OR NOT ISBLANK ISERROR ISNUMBER
  ISTEXT; ROUND ROUNDUP ROUNDDOWN ABS INT MOD SQRT POWER; LEN UPPER LOWER TRIM LEFT RIGHT MID
  FIND SEARCH REPLACE SUBSTITUTE TEXT INCLUDES STARTSWITH ENDSWITH; REF (expressions only).
  Excel range-vs-scalar coercion rules apply.
- `evaluator.js`: pure AST evaluator; lazy `IF`/`IFERROR`/`IFNA`; error propagation; overflow
  gives `#NUM!`; `displayValue`. The context supplies `resolvePath` and a depth guard
  (backstop against embed cycles).

## Errors (`errors.js`)

`FormulaError` singletons in `ERR`: `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#NUM!`, `#N/A`,
`#CIRC!`, `#ERROR!`. Each code has a plain-language message and hint. Where detail is known
(unresolved name with "did you mean", vanished range, origin of a propagated error), a
derived error with the same `code` carries it, so `isFormulaError` and `.code` still work.
Tests compare singletons with `toBe(ERR.X)`; derived errors only appear where detail is
attached. Unresolved/ambiguous name is `#NAME?`; misused handle `#VALUE!`; vanished range
`#REF!`; formula cycle `#CIRC!`.

## References and rewriting

- `references.js`: A1 parse/format, absolute/mixed markers, `refKey`, range normalisation
  and containment.
- Rewrite helpers are token-level (they slice by token `end`), so they preserve spacing and
  strings: `shift.js` (`shiftFormulaReferences`, row/column insert/delete; absolute markers
  do not exempt a reference; deleted targets become `#REF!`), `cell-shift.js`
  (`retargetMovedReferences`, insert/delete cells), `fill.js` (`offsetFormulaReferences`:
  relative refs move, `$` pins an axis, off-sheet becomes `#REF!`).
- Name resolution, scope rules and cross-table rewriting are in `references.md`.

## Workspace-wide graph (`references/table-engine.js`)

`TableEngines` keeps one cell-keyed dependency graph for the whole workspace (a table-level
order is insufficient: `T1!A1 -> T2!A1` with `T2!B1 -> T1!B1` is cell-acyclic). The per-table
API (`display`, `value`, `forget`) is what `sheet/render.js` and the sheet editor use. The
engine is rebuilt from the sparse store on every change.

## Tests

`tokenizer`, `parser`, `evaluator`, `recalc`, `references`, `formula-errors`,
`formula-functions`, `calc-refscan`, `cross-table`.
