/**
 * The stylesheets of exported files, written by hand as a subset of the app's: an export has
 * to look right with no app around it, and the app's stylesheet is built for editing (cursors,
 * selection, handles). Class names are the renderers'; keep them in step with `src/styles/`.
 */

/** Slide drawing: shared by the page and by a slide exported as a standalone SVG. */
export const SLIDE_CSS = `
.slide{position:absolute;left:0;top:0;overflow:hidden;transform-origin:0 0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;color:#1d1d1f}
.slide-object{position:absolute;box-sizing:border-box}
.slide-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.slide-line-hit{display:none}
.slide-image{display:block;width:100%;height:100%;object-fit:fill}
.slide-text{position:absolute;inset:0;box-sizing:border-box;display:flex;flex-direction:column;padding:8px 12px;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2}
.slide-text code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.slide-object-reference{overflow:hidden}
.slide-reference{position:absolute;inset:0;overflow:hidden;font-size:18px;line-height:1.3}
.slide-reference .reference-blocks{padding:8px 12px;white-space:normal}
.slide-text .inline-ref:has(.reference-table,.reference-slide,.reference-slides,.reference-blocks){display:block;white-space:normal}
`;

/** Content the renderers share: embedded references and the static sheet grid. */
export const CONTENT_CSS = `
.reference-table{overflow:auto}
.reference-table .sheet-table.is-embedded{position:static}
.reference-table .sheet-table-name{display:none}
.reference-slides{display:flex;flex-direction:column;gap:8px}
.reference-slide{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:6px}
.reference-range{border-collapse:collapse}
.reference-range td{padding:3px 8px;border:1px solid var(--border)}
.reference-chip{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--accent-soft);font-size:.95em}
.reference-chip.is-error{background:#fdecec;color:var(--danger);font-family:var(--mono);font-size:.85em}
.reference-missing{color:var(--muted);font-style:italic}
.reference-blocks>*:last-child{margin-bottom:0}
.inline-ref .reference-blocks>*{margin-bottom:6px}
.sheet-grid{border-collapse:collapse;font-size:13px;table-layout:fixed}
.sheet-grid th,.sheet-grid td{border:1px solid var(--border);padding:2px 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sheet-col-header,.sheet-row-header,.sheet-corner{background:var(--panel);color:var(--muted);font-size:10px;font-weight:500;text-align:center}
.sheet-cell{background:#fff;vertical-align:middle}
`;

/** The colours and fonts the shared styles refer to. */
export const VARS_CSS = `
:root{--text:#1d1d1f;--muted:#6e6e73;--accent:#1d6fdc;--accent-soft:#e6f0ff;--border:#e3e3e6;--panel:#f7f7f5;--code-bg:#f4f4f6;--danger:#d0021b;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
`;

/** What a slide exported as a standalone SVG needs: variables, shared content and the slide itself. */
export const STANDALONE_SLIDE_CSS = `${VARS_CSS}
${CONTENT_CSS}
${SLIDE_CSS}`;

/** The stylesheet of an exported HTML page. */
export const PAGE_CSS = `
${VARS_CSS}
*{box-sizing:border-box}
body{margin:0;color:var(--text);background:#fff;font:16px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif}
main{max-width:820px;margin:0 auto;padding:32px 24px 96px}
a{color:var(--accent)}
.export-nav{max-width:820px;margin:0 auto;padding:16px 24px 0;font-size:14px;color:var(--muted)}
.export-nav a{margin-right:12px}
.page-title{margin:0 0 20px;line-height:1.2}
h1.page-title{font-size:34px}
.export-page+.export-page{margin-top:64px;padding-top:32px;border-top:1px solid var(--border)}
.document>*{margin:0 0 12px}
h1,h2,h3,h4,h5,h6{line-height:1.25}
h2{font-size:28px;margin:18px 0 10px}
h3{font-size:22px;margin:16px 0 8px}
h4{font-size:18px;margin:14px 0 6px}
h5,h6{font-size:16px;margin:12px 0 6px}
blockquote{margin:0 0 12px;padding-left:14px;border-left:3px solid var(--border);color:var(--muted)}
ul,ol{margin:0 0 12px;padding-left:26px}
li{margin:2px 0}
.item-children{margin:4px 0 4px 2px}
code{font-family:var(--mono);font-size:.92em;background:var(--code-bg);border-radius:4px;padding:1px 4px}
pre{margin:0 0 12px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto}
pre code{background:none;padding:0;white-space:pre}
hr{border:none;border-top:1px solid var(--border);margin:18px 0}
figure{margin:0 0 12px}
figure[data-align=left]{text-align:left}
figure[data-align=right]{text-align:right}
figure:not([data-align]){text-align:center}
img{max-width:100%;height:auto}
.export-table{border-collapse:collapse;margin:0 0 16px;font-size:14px}
.export-table td,.export-table th{border:1px solid var(--border);padding:4px 10px;text-align:left;vertical-align:top}
.export-table caption{caption-side:top;text-align:left;font-weight:600;padding-bottom:6px}
.export-slides{overflow:auto;max-width:100%;display:flex;flex-direction:column;gap:16px}
.export-slides figure{margin:0}
.export-slides svg{display:block;flex:none;border:1px solid var(--border)}
.export-slides figcaption{font-size:13px;color:var(--muted);margin-top:4px}
.export-index ul{list-style:none;padding-left:20px}
.export-index>ul{padding-left:0}
.export-toc{margin:0 0 32px;padding:12px 16px;background:var(--panel);border-radius:8px}
.export-toc ul{margin:0;list-style:none;padding-left:18px}
.export-toc>ul{padding-left:0}
body[data-sections=target] .export-page{display:none;margin-top:0;padding-top:0;border-top:none}
body[data-sections=target] .export-page:target{display:block}
body[data-sections=target] main:not(:has(.export-page:target))>.export-page:first-of-type{display:block}
${CONTENT_CSS}
${SLIDE_CSS}
@media print{.export-nav,.export-toc{display:none}.export-page{break-before:page}}
`;
