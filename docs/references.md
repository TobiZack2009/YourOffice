# Sections, embeds and expression references

`src/references/` plus the UI in `src/app/`. Landed (Phase 6). Spec §5.3, §8, §9. The
expression language itself is in `formulas.md`.

## Concepts

- A **section** names a piece of content: `content.sections[id] = {id, name?, locator,
  implicit?}` on each page. Locators by page type:
  - document `{startBlockId, endBlockId}` (a contiguous run of sibling blocks);
  - sheet `{tableId, range?}`;
  - presentation `{slideId}`, or `{slideId: first, slideIds: [...]}` for several slides (any
    set; `slideLocator` builds the canonical form, ids in presentation order).
  Tables and slides get an unnamed implicit section when first embedded
  (`references/catalog.js` `ensureSection`), so every embed goes through a section.
- A **reference instance** is `{id, kind: "embed"|"expression", sectionId | expression,
  display}`. It lives as a document `sectionRef` block, an inline run `{text: REF_CHAR, ref}`
  (atomic, one character), or a presentation `reference` object. `references/hosts.js` is the
  single scan of hosts.
- **Embeds** are live and editable for documents: edits reach every copy. Sheet and slide
  embeds are static, image-like views. **Expressions** are read-only and can return any value
  type, including blocks, a table/range, a slide, or empty (`IF(cond, Summary, "")` shows or
  hides a read-only embed). Inline fallback: block results show as plain text; tables and
  slides give `#VALUE!`.

## Scope and name resolution (`scope.js`, `rewrite.js`)

- Page nesting is scope nesting. A page's members are its tables, named sections and child
  pages. Bare names resolve innermost-out, first match wins; so a section on another page
  needs a `Page!Name` path. Paths resolve each segment inside the previous.
- Duplicate table/section names in a scope are auto-suffixed on create/rename (`uniqueName`).
  Page titles may repeat; an ambiguous page segment gives `#NAME?` and an editor warning.
- Renames rewrite every expression and cell formula using the name, token by token. A page
  move, or a new/renamed name that would re-point an existing bare name, first rewrites the
  affected expressions to a qualified path keeping the same target (`qualifyToKeepTarget`),
  in the same transaction. Hooks live in `renamePage`, `movePage`, `deletePage`,
  `renameTable`, `createTable` and `renameSection`.
- `closestName` powers "did you mean"; `collectNames(ast)` lists referenced names.

## Cross-table formulas

`Expenses!B2` works. `references/cross-table.js` rewrites formulas in other tables and
expressions on row/column insert/delete, cell insert/delete and `moveCells`. Deleting a
referenced table detaches it instead of producing `#REF!`. The workspace-wide dependency graph
is described in `formulas.md`.

## Commands (`references/commands.js`)

`createSection`, `renameSection` (rewrites referencing names), `removeSection` (content kept),
`insertReference`, `updateReference`, `removeReference`, `setExpression`, `restoreDetached`.

- `insertReference` / `updateReference` validate (parse, resolve, cycle check, evaluate) and
  throw `CommandError` with reason `invalidReference`. Any error blocks insertion, including
  data-dependent ones; lazy `IF` evaluates only the taken branch. Plain embeds fail for cycle,
  missing target and type mismatch. Errors after insertion render as an error chip with an
  explanation and are flagged in "Show references".
- `aroundCommand` hooks capture and heal section locators around block commands, sweep the
  detached store and run the cycle check. Commands registered `hot` (typing, dragging) skip
  them and `selfManaged` ones (`deletePage`, `resizeSection`) skip the capture; the same hook
  respells formulas after `createPage`, `renamePage` and `movePage`, and moves the contents of
  deleted pages into the detached store.
- `references/index.js` (pure): reverse index of embeds, expressions and formulas with
  counts; `wouldCycle`; `validateReference`. Cycles are checked at insertion, expression
  edits, dragging blocks into a section that references them, and workspace import. Embed
  cycles are rejected at insertion; the evaluator depth guard is the backstop.

## Detached store

`workspace.detached` holds content whose source was deleted while referenced (page, block,
table, slide). Every reference keeps rendering and editing it. Removing the last reference
discards it in the same transaction (undoable). Any reference counts: embeds, expressions and
cell formulas. Detach hooks sit in `deletePage`, `deleteBlock`, `deleteTable`, `deleteSlide`
and `deleteObjects`. Deleting some of a multi-slide section's slides shrinks its locator;
deleting all detaches them (sections sharing a vanished slide share one detached entry). A
fully deleted range section is removed rather than detached. Restore-to-page is offered when
the page type matches.

## Fit rule (`fit.js`, pure)

Scalars, empty and errors are inline; blocks only when they are one paragraph/heading/quote;
tables and slides when display width <= 50% of the container. A breaking inline embed renders
text / embed / text while the paragraph stays one block. A multi-slide embed draws slides
stacked (`.reference-slides`) and never flows inline.

## UI

- **`handles.js`**: shared hover handle. Documents: a gutter handle on every block (Make
  section, rename, show references, remove section; a multi-block selection becomes one
  section; blocks drag as one transaction, the section keeps its id). Embed menu: go to source,
  remove. Sheets: follows the selection (see `sheet-editor.md`). Slides: click-only handle in
  the strip; a selection of several slides becomes one section.
- **`reference-picker.js`**: searchable tree with live previews (pages, then tables, ranges,
  slides, named sections; a named multi-slide section is listed under its presentation).
- **`expression-editor.js`**: popover with live result, plain-language error, a list of the
  referenced names with number markers and `is-ref-N` underline colours, and Insert/Apply
  disabled while invalid.
- **`reference-view.js`** (document host): one frame per reference record id (block-level embed,
  block-level expression and inline reference). The frame element, its handle and its body are kept
  between host passes and patched in place (state classes, `data-*`, handle icon and label); the
  handle and double-click read the frame's current record. A nested document editor is cached by
  section and container. A static body (table, slide, expression value, missing note) is drawn
  each pass but replaces the shown one only when it is not `isEqualNode` to it, so an unchanged
  reference keeps its nodes. A record id drawn twice in one pass (a copy) gets an uncached frame;
  frames of ids not drawn in a pass are dropped.
- **`notice.js`**: one `CommandError` surface shared by all three editors.
- Insert tab: Reference group (Embed, Expression) for documents and presentations; the sheet
  one stays a disabled seam. Presentation specifics (reference objects, `autoHeight`
  measurement, slide-embed swap) are in `presentation.md`.
- Error explanation surfaces: sheet error cells (message line under the formula bar), the
  expression editor (under its field), error chips (on click).

## Known limitations

- Embedding into sheets is disabled.
- Colours are a subset: names get a marker and underline colour in the expression editor, but
  there is no token colouring, cell outlines, point mode or drag-to-repoint (AST nodes carry no
  offsets).
- Inline refs and slide embeds are static; edit via the source or a block-level document
  embed. Inline refs in slide text have no handle.
- Cycle errors carry no path detail; cell-formula to section cycles rely on the evaluator depth
  guard.
- The shared engine rebuilds the whole workspace per refresh.
- Everything that draws references (document frames, slide reference objects, strip thumbnails) re-examines all of them on every change to any page: drawings are rebuilt and compared, not skipped, because a reference can depend on other pages through formulas, nested embeds and name shadowing and no dependency set is tracked. Nodes keep their identity when nothing changed.
- Arrow navigation in a document host skips embed blocks.
- An inline embed's inline/break choice reads `clientWidth` at render time (0 when unmounted,
  so tables and slides break until re-rendered).
- Page-title ambiguity gives `#NAME?`.
- Multi-slide sections cannot be dragged as a group; the slide strip handle is click-only.

## Tests

`references-scope`, `references-rewrite`, `references-catalog`, `references-commands`,
`references-fit`, `references-multi-slide`, `cross-table`, `app-references`,
`app-block-references`, `app-reference-view` (frame node identity), `app-inline-references`, `app-sheet-references`,
`app-slide-references`, `app-presentation-references`.
