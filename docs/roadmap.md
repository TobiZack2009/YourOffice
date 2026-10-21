# Roadmap

Reordered from spec §16 to land testable foundations first. Phases 1-6 are done.

1. **Workspace foundation** (done): versioned schema, stable IDs, command bus, transactions,
   undo/redo, dirty state, JSON import/export. See `workspace.md`.
2. **Formula engine** (done): tokenizer, parser, evaluator, dependency graph, incremental
   recalc, cycle detection, A1/absolute/mixed refs, Excel error values. See `formulas.md`.
3. **Document editor** (done): ordered and nested blocks, rich text runs, links, pure
   renderer. Block export outstanding. See `document-editor.md`.
4. **Sheet editor** (done, polish outstanding): Numbers-style canvas, independent tables,
   sparse storage, range selection, fill/copy/move, merge, table drag. Outstanding:
   incremental engine updates, cross-table visual polish. See `sheet-editor.md`.
5. **Presentation** (done): shared canvas size, text/image/shape/line, transitions,
   animations, slide show. See `presentation.md`.
6. **References / sections** (done; limitations in `references.md`): typed locators, reference
   instances, live embeds, expressions with conditionals, detached store, cycle checks.
7. **Persistence / interchange:** IndexedDB autosave + recovery is done (`persistence.md`).
   Outstanding: Markdown, CSV, PDF, limited Office formats; image assets move into the asset registry.
8. **Standalone export:** pristine-shell single-HTML export (editable + read-only enforced at
   the command layer), asset embedding, `<script type="application/json">` payload with
   escaping, Playwright round-trip validation.

## Still open

- Whether `#CIRC!` stays, or a standard code is adopted once Excel/Sheets behaviour is pinned
  down (currently centralised in `calc/errors.js`).
- Section identity rules when source blocks split, merge or move (current behaviour is the
  locator healing in `references/commands.js`).
- Variable/parameter resolution order and missing-value behaviour (spec §17); parameters are
  not implemented.

Deferred features per area are listed at the end of each area doc.
