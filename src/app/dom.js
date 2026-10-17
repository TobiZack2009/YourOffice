/**
 * Tiny DOM helpers for the app layer. Deliberately minimal: elements are built
 * with `h`, text via textContent (never innerHTML), and event listeners attached
 * through the props object.
 */

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, unknown>} [props] Attributes: `class`, `text`, `dataset`,
 *   `on*` handlers, plus any other attribute (true → empty attribute).
 * @param {Array<Node | string | null | undefined | false> | Node | string} [children]
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, children = []) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      element.className = String(value);
    } else if (key === "text") {
      element.textContent = String(value);
    } else if (key === "dataset") {
      Object.assign(element.dataset, /** @type {Record<string, string>} */ (value));
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else {
      element.setAttribute(key, value === true ? "" : String(value));
    }
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return element;
}

/**
 * Remove all children of an element.
 * @param {Element} element
 */
export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

/**
 * @param {Array<Node | string | null | undefined | false>} children
 * @returns {DocumentFragment}
 */
export function fragment(children) {
  const doc = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    doc.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return doc;
}

/**
 * Closest ancestor (inclusive) matching a selector with a given data attribute.
 * @param {Node | null} node
 * @param {string} attribute
 * @returns {HTMLElement | null}
 */
export function closestWithData(node, attribute) {
  let current = node instanceof Element ? node : node?.parentElement ?? null;
  while (current) {
    if (current.hasAttribute(attribute)) return current;
    current = current.parentElement;
  }
  return null;
}
