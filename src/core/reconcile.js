/**
 * Make `parent` hold exactly `children`, in order, moving as little as possible.
 *
 * Nodes that are already in place are not touched, so an element that has focus (a caret in a
 * text block, an input) keeps it; browsers drop focus from a node that is removed and put back.
 * Nodes that are no longer wanted are removed; the rest are inserted where they belong.
 *
 * @param {Node} parent
 * @param {Node[]} children
 */
export function reconcileChildren(parent, children) {
  const wanted = new Set(children);
  let cursor = parent.firstChild;
  for (const node of children) {
    while (cursor && !wanted.has(cursor)) {
      const stale = cursor;
      cursor = cursor.nextSibling;
      parent.removeChild(stale);
    }
    if (cursor === node) {
      cursor = cursor.nextSibling;
    } else {
      parent.insertBefore(node, cursor);
    }
  }
  while (cursor) {
    const stale = cursor;
    cursor = cursor.nextSibling;
    parent.removeChild(stale);
  }
}
