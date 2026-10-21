# Export

Turns pages into HTML, Markdown or CSV files, in memory. The UI (menus, settings dialog), PNG,
PDF, import and the standalone full-app export are not built yet (see the end of this doc).

Code: `src/export/`. The area imports `core`, `workspace`, `calc`, `document`, `presentation`,
`sheet` and `references`; `app` may import it. It never touches storage, the clock or the
global `document`.

## API

```js
import { exportPages, bundleExport } from "../export/index.js";

const result = exportPages(workspace, request, { document });
// { files: [{ path, mime, text }], skipped: [{ pageId, title, reason }], warnings: [], plan }
const bundle = bundleExport(result, "My notes");
// { name, mime, bytes } or null when nothing was exported
```

`exportPages` reads a snapshot of the workspace and never changes it (no command, no undo
entry). `env.document` is the DOM used to draw HTML and slides; it is required for `html`
(`exportPages` throws "needs a DOM" without it). Markdown works without one, but then a slide
cannot be drawn and is listed by name with a warning. CSV needs no DOM.

`bundleExport` returns one file as it is (its own name and type) and several as a store-only
zip named after the slugified title (`application/zip`).

## Request

| Option | Default | Meaning |
| --- | --- | --- |
| `format` | required | `html`, `markdown` or `csv` |
| `pageIds` | every page | the pages to export |
| `includeChildren` | `true` | also export each page's sub-pages |
| `includeLinked` | `true` | also export pages reached through links, transitively |
| `layout` | `files` | `files`: one file per page; `single`: all pages in one file under headings |
| `subfolders` | `false` | files layout: mirror the page tree as folders |
| `sectionStyle` | `headings` | single-file HTML: `target` shows one page at a time, chosen by the address (`:target`) |
| `slides` | `{ mode: "gallery", format: "svg" }` | `gallery`: every slide on the presentation's page; `subpages`: a file per slide with previous / overview / next links |

## Plan (`plan.js`)

`planExport` resolves a request into the list of pages in sidebar order, each with a file path,
a unique stem, a fragment anchor and its slide paths. Names come from `names.js`: page names are
unique case-insensitively (`nameKey`), titles are slugified to file-safe names, collisions get a
numeric suffix, and `relativePath` computes links between files in different folders. A page is
reached through a link when a document holds a page-link block or a text link to `#<pageId>`;
`linkedPageIds` follows these transitively. Pages that the format cannot carry (every non-sheet
page for CSV) are reported in `skipped` rather than silently dropped. A multi-page files export
adds an `index` file (a nested list of the exported pages).

Links between pages become links between the exported files (or `#anchor` in single layout). A
link to a page that was left out keeps its text and loses the link.

## Formats

**HTML** (`html-render.js`): each page is a complete document with its own stylesheet
(`styles.js`, no external requests), a title, a link back to the index and the page's content
drawn by the same renderers as the app (`renderDocument`, tables, slides), so output matches the
editor. Editor attributes (`data-block-id`, `contenteditable`, ...) are removed. Headings are
shifted below the page title. External links get `rel="noopener noreferrer"`; images are
`data:` addresses from the asset registry (missing assets warn). Sheets are plain
tables, one per table, showing what the sheet shows. Embeds (sections, expressions) are drawn
inline as static content. Presentations in gallery mode are inline fixed-size SVGs in a
scrolling container; in subpages mode the page lists links and each slide has its own file.

**Markdown** (`markdown.js`): pure text. Inline characters and line starts are escaped; marks
nest, outermost first, as link, bold (`**`), italic (`*`), underline (`<u>`), strike (`~~`), code; hard breaks are
`  \n`. Images and slides are reference-style (`![alt][image-1]`, definitions at the end of the
file); a slide is a `data:image/svg+xml` image. Tables are GFM tables whose first row is the
header (Markdown has no headerless table). Embeds are written inline (depth limit 6);
expressions as their result. Single layout adds a contents list and an `<a id>` before each
page only when there is more than one page.

**CSV** (`csv.js`): sheets only, RFC 4180 quoting, `\r\n` rows, values as displayed. A sheet
with one table is `<Page>.csv`; with several, `<Page>-<table>.csv` each. A sheet with no tables
warns.

**Slide SVG** (`slide-svg-render.js`): an `<svg>` of the slide's size containing a
`foreignObject` with the slide drawn by `renderSlide`, so text, tables and embeds look as they
do in the app. Standalone files carry their stylesheet and an XML prolog; XML-invalid control
characters are stripped. SVG placed in an HTML page leans on the page's stylesheet.

## Static rendering (`static-render.js`)

Draws sections, tables, slides and expressions without an editor: the single implementation
behind the app's live embeds (it takes an injected `document`) and the export. The export
context (`context.js`) supplies the document, per-sheet formula engines, asset and page-title
lookups and a warning list that `exportPages` de-duplicates.

## Zip (`zip.js`)

`createZip(entries)` / `readZip(bytes)`: store-only archives with CRC-32, UTF-8 names. No
compression, so a bundle is as large as its files.

## Tests

`export-names`, `export-zip`, `export-csv`, `export-plan`, `export-markdown`, `export-html`,
`export-slide-svg`, `export-index`, sharing `tests/export-fixture.js`.

## Limitations and deferred

- No UI: right-click and File menu entry points, the settings dialog and downloads.
- PNG slides and PDF; slides are SVG only.
- Import (HTML, Markdown, CSV, JSON).
- Standalone full-app export and URL sharing.
- Markdown cannot express merged cells, colours, fonts, or a headerless table.
- Zips are uncompressed.
