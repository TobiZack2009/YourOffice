/**
 * Document renderer (spec §2.3): pure functions from block model to DOM.
 *
 * Nothing here reads or writes model state; the caller passes content and gets
 * elements back. Text is always assigned via textContent — never innerHTML — so
 * user content cannot inject markup. Elements carry `data-block-id` /
 * `data-item-id` so editing glue (later phases) can map DOM back to model ids.
 */

/** @typedef {import("./model.js").Block} Block */
/** @typedef {import("./model.js").InlineRun} InlineRun */
/** @typedef {import("./model.js").DocumentContent} DocumentContent */

/**
 * @typedef {object} RenderOptions
 * @property {Document} [document] DOM implementation (defaults to global).
 * @property {(pageId: string) => string | undefined} [resolvePageTitle]
 * @property {(assetId: string) => string | undefined} [resolveAssetUrl]
 */

/**
 * @param {RenderOptions} [options]
 * @returns {Document}
 */
function getDocument(options) {
  const doc = options?.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) throw new Error("no DOM available; pass options.document");
  return doc;
}

/**
 * Render inline runs into a DocumentFragment.
 * @param {InlineRun[]} runs
 * @param {RenderOptions} [options]
 * @returns {DocumentFragment}
 */
export function renderRuns(runs, options) {
  const doc = getDocument(options);
  const fragment = doc.createDocumentFragment();

  for (const run of runs) {
    const text = doc.createTextNode(run.text);
    let node = /** @type {Node} */ (text);
    const marks = run.marks ?? {};

    // Wrap from innermost to outermost so the visual nesting is predictable.
    if (marks.strike) node = wrap(doc, "s", node);
    if (marks.underline) node = wrap(doc, "u", node);
    if (marks.italic) node = wrap(doc, "em", node);
    if (marks.bold) node = wrap(doc, "strong", node);
    if (marks.code) node = wrap(doc, "code", node);
    if (marks.link) {
      const anchor = doc.createElement("a");
      anchor.setAttribute("href", marks.link);
      anchor.appendChild(node);
      node = anchor;
    }
    fragment.appendChild(node);
  }

  return fragment;
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {Node} child
 * @returns {HTMLElement}
 */
function wrap(doc, tag, child) {
  const element = doc.createElement(tag);
  element.appendChild(child);
  return element;
}

/**
 * Render a single block.
 * @param {Block} block
 * @param {RenderOptions} [options]
 * @returns {HTMLElement | null} null for unknown types (defensive skip).
 */
export function renderBlock(block, options) {
  const doc = getDocument(options);

  switch (block.type) {
    case "paragraph":
    case "quote": {
      const element = doc.createElement(block.type === "quote" ? "blockquote" : "p");
      element.appendChild(renderRuns(block.runs ?? [], options));
      return decorate(element, block);
    }
    case "heading": {
      const level = Math.min(3, Math.max(1, block.level ?? 1));
      const element = doc.createElement(`h${level}`);
      element.appendChild(renderRuns(block.runs ?? [], options));
      return decorate(element, block);
    }
    case "list": {
      const element = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items ?? []) {
        const li = doc.createElement("li");
        li.setAttribute("data-item-id", item.id);
        li.appendChild(renderRuns(item.runs, options));
        element.appendChild(li);
      }
      return decorate(element, block);
    }
    case "code": {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (block.language) code.className = `language-${block.language}`;
      code.textContent = block.text ?? "";
      pre.appendChild(code);
      return decorate(pre, block);
    }
    case "divider": {
      const hr = doc.createElement("hr");
      return decorate(hr, block);
    }
    case "image": {
      const figure = doc.createElement("figure");
      if (block.align && block.align !== "center") {
        figure.setAttribute("data-align", block.align);
      }
      const url = block.assetId ? options?.resolveAssetUrl?.(block.assetId) : undefined;
      if (url) {
        const img = doc.createElement("img");
        img.setAttribute("src", url);
        img.setAttribute("alt", block.alt ?? "");
        img.setAttribute("loading", "lazy");
        if (typeof block.width === "number") {
          img.setAttribute("width", String(block.width));
        }
        figure.appendChild(img);
      } else {
        figure.setAttribute("data-missing-asset", block.assetId ?? "");
        figure.textContent = block.alt ?? "Missing image";
      }
      return decorate(figure, block);
    }
    case "pageLink": {
      const anchor = doc.createElement("a");
      anchor.setAttribute("href", `#${block.pageId}`);
      anchor.setAttribute("data-page-id", block.pageId ?? "");
      anchor.className = "page-link";
      const title = block.pageId ? options?.resolvePageTitle?.(block.pageId) : undefined;
      anchor.textContent = title ?? block.pageId ?? "";
      return decorate(anchor, block);
    }
    case "sectionRef": {
      const span = doc.createElement("span");
      span.className = "section-ref";
      span.setAttribute("data-section-id", block.sectionId ?? "");
      span.textContent = `Section: ${block.sectionId ?? ""}`;
      return decorate(span, block);
    }
    case "sheetEmbed": {
      const div = doc.createElement("div");
      div.className = "sheet-embed";
      div.setAttribute("data-page-id", block.pageId ?? "");
      if (block.tableId) div.setAttribute("data-table-id", block.tableId);
      div.textContent = "Embedded sheet";
      return decorate(div, block);
    }
    case "slideRef": {
      const span = doc.createElement("span");
      span.className = "slide-ref";
      span.setAttribute("data-page-id", block.pageId ?? "");
      if (block.slideId) span.setAttribute("data-slide-id", block.slideId);
      span.textContent = "Slide reference";
      return decorate(span, block);
    }
    default:
      return null;
  }
}

/**
 * @param {HTMLElement} element
 * @param {Block} block
 * @returns {HTMLElement}
 */
function decorate(element, block) {
  element.setAttribute("data-block-id", block.id);
  element.setAttribute("data-block-type", block.type);
  return element;
}

/**
 * Render a document page's content into an <article>.
 * @param {DocumentContent} content
 * @param {RenderOptions} [options]
 * @returns {HTMLElement}
 */
export function renderDocument(content, options) {
  const doc = getDocument(options);
  const article = doc.createElement("article");
  article.className = "document";

  for (const id of content.blockOrder) {
    const block = content.blocks[id];
    if (!block) continue;
    const element = renderBlock(block, options);
    if (element) article.appendChild(element);
  }

  return article;
}
