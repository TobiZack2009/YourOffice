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
with animations and slide show, sections/embeds/expression references). Next: Phase 7
(persistence/interchange), then Phase 8 (standalone export). See `docs/roadmap.md`.

**1135 tests green across 60 files; the single-file build is ~407 kB.** Update these two
numbers when they change.

## Verification

- `npm test` (Vitest, jsdom). Most suites are environment-agnostic. Tests are named after the
  module they cover.
- `npm run build` (Vite + `vite-plugin-singlefile` inlines JS and CSS into one HTML).
- UI work gets a throwaway Chrome smoke script (playwright-core, `channel: "chrome"`, against
  `dist/index.html`); these are not part of `npm test`.

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
  app/           shell, ribbon, sidebar, editors, popovers
  main.js        vite entry
docs/            spec and the docs below
tests/           vitest suites
```

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
| `docs/roadmap.md` | Phases and open items |

## Maintaining the docs

- Each area doc describes the current state, not history. When behaviour changes, edit the
  paragraph that describes it; do not append a dated log entry.
- Add a deferred feature or known limitation to the end of the relevant area doc.
- A new module goes in the source map above and in the doc for its area. A new area gets its own
  file and a row in the table.
- `CLAUDE.md` includes this file and must not be edited.
