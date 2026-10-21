# AGENTS.md

Entry point for working on YourOffice. This file stays short: it says what the product is,
how to verify changes, and where the detailed docs live. Keep it and the docs in `docs/`
current as work proceeds; do not let them drift from the code.

## Product

YourOffice is a local-first, privacy-focused office suite: documents, spreadsheets and
presentations sharing one workspace, one page hierarchy, one asset registry, one history
system and one cross-editor reference system. It ships as a single standalone HTML file
(editable or read-only), with no backend and no network. Vanilla JS, Vite, Vitest.

The product/technical spec is `docs/app.txt` (source of truth for requirements).

## Status

Phases 1-6 are done (workspace, formula engine, document editor, sheet editor, presentation
with animations and slide show, sections/embeds/expression references). Phase 7's IndexedDB autosave and recovery is
done; the interchange formats (Markdown, CSV, PDF) remain, then Phase 8 (standalone export). See `docs/roadmap.md`.

**1258 tests green across 72 files; the single-file build is ~435 kB.** Update these two
numbers when they change.

## Verification

- `npm test` (Vitest, jsdom). Most suites are environment-agnostic. Tests are named after the
  module they cover.
- `npm run build` (Vite + `vite-plugin-singlefile` inlines JS and CSS into one HTML).
- UI work: `npm run build && npm run smoke` drives the built file in real Chrome
  (`scripts/smoke.mjs`, playwright-core, `channel: "chrome"`); it is not part of `npm test`.
  Extend it when a UI change adds behaviour jsdom cannot check (focus, selection, IndexedDB).
- `npm run typecheck` (`tsc` + `checkJs`) is advisory: it still reports 129 errors. Do not add new ones.
- `tests/architecture.test.js` enforces the import layering, DOM-free model layers, the `getPage`
  allowlist, no `persistence` imports from `app`, and file size ceilings. If it fails, fix the code;
  change the test only with a matching entry under Deviations in `docs/architecture.md`.

## Source map

```
src/
  core/          ids, events, error types
  workspace/     schema, store, built-in commands, import/export
  sheet/         formula engine, table model/commands/render
  document/      block model, commands, renderer
  presentation/  slide model, commands, geometry, animation/slideshow logic, renderer
  references/    scope, sections, reference commands, detached store, fit rule
  domain/        composition root (installDomain, createWorkspace, full validation rules)
  app/           shell, ribbon, sidebar, editors, popovers, demo seed
  persistence/   storage adapters (IndexedDB, memory), autosave, start-up restore
  boot.js        start-up flow (storage, restore, mount); main.js is the thin vite entry
  main.js        vite entry
docs/            spec and the docs below
tests/           vitest suites
```

## Architecture rules

The model says what is true; the session says what the user is doing; controllers translate
intent into commands; views render those answers. Full rules, with what enforces each, are in
`docs/architecture.md`. The short form:

1. Dependencies point down: `core <- workspace <- sheet|document|presentation <- references <-
   domain <- app`; `persistence` sits beside `app` and only `boot.js` wires it in.
2. Durable state lives in the workspace and changes only through commands. Commands validate, return
   the ids they create, and record the entities they touch. Model code never touches the DOM.
3. User state (selection, open page, zoom, folds, clipboard) lives in `app/session.js`, not in the
   workspace or module globals.
4. `render*.js` never dispatch. Editors turn events into `dispatch(type, payload, { origin })`.
5. Read through `workspace/selectors.js`; `getPage`/`getPages` are snapshot APIs.
6. One change flow: dispatch, `change` event, each editor patches itself. Never re-render by hand
   after a dispatch. Command behaviour flags are registration metadata, not hand lists.
7. Keyed rendering: caches keyed by id with a signature; never replace an element the user is
   editing; each keyed view gets a node-identity test.
8. Listeners and timers belong to a gesture scope or `destroy`; UI services are per-mount
   instances; shortcuts go through `app/keyboard.js`; model undo only inside `data-history="model"`.
9. Untrusted data passes the full validators at import, `setPageContent` and export; URLs pass
   `isSafeUrl` in both validator and renderer.
10. Storage, clocks and session backing are injected adapters.
11. Split a file before adding to it past ~800 lines; a feature is model, commands, renderer,
    controller, tests and a doc paragraph.
12. Done means: module-named tests, `npm test` and `npm run build` green, area doc and the counts
    above updated, a smoke run for UI work, and every exception recorded under Deviations.

## Docs

| File | Covers |
| --- | --- |
| `docs/app.txt` | Product and technical spec |
| `docs/architecture.md` | Principles, layering, key types, deviations from the spec |
| `docs/workspace.md` | Schema, store, transactions, built-in commands, import/export |
| `docs/formulas.md` | Tokenizer, parser, evaluator, functions, errors, dependency graph |
| `docs/document-editor.md` | Block model, commands, block editor, selection, links |
| `docs/sheet-editor.md` | Table model, commands, sheet editor, fill/move/merge |
| `docs/presentation.md` | Slides, editor, animations, slide show |
| `docs/references.md` | Sections, embeds, expressions, scope, detached store, limitations |
| `docs/app-shell.md` | Shell, ribbon, sidebar, popovers, icons |
| `docs/persistence.md` | IndexedDB storage, autosave, recovery, start-up |
| `docs/roadmap.md` | Phases and open items |

## Maintaining the docs

- Each area doc describes the current state, not history. When behaviour changes, edit the
  paragraph that describes it; do not append a dated log entry.
- Add a deferred feature or known limitation to the end of the relevant area doc.
- A new module goes in the source map above and in the doc for its area. A new area gets its own
  file and a row in the table.
- `CLAUDE.md` includes this file and must not be edited.
