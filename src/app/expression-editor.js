/**
 * The expression editor: a small popover with one field, name suggestions, a live
 * result and, when the text cannot be used, the reason in plain words.
 *
 * Apply / Insert stays disabled while the expression errors, so a bad expression
 * never reaches the model (the commands check again and refuse with the same message).
 * The names an expression reads are listed with a number and an underline colour
 * (`is-ref-N`, by first appearance), a cue that does not rely on colour alone.
 */

import { collectNames } from "../references/scope.js";
import { evaluateExpression } from "../references/expression.js";
import { suggestNames } from "../references/catalog.js";
import { explain, isFormulaError } from "../sheet/errors.js";
import { clear, h } from "./dom.js";
import { enginesFor, renderValue } from "./reference-render.js";

const PALETTE_SIZE = 6;
const MAX_SUGGESTIONS = 8;

/**
 * The word being typed at the end of the text (a name prefix), or null.
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, prefix: string } | null}
 */
export function wordBeforeCaret(text, caret) {
  const head = text.slice(0, caret);
  const quoted = /'(?:[^']|'')*$/.exec(head);
  if (quoted) return { start: quoted.index, prefix: quoted[0] };
  const match = /[A-Za-z_][\w.]*$/.exec(head);
  return match ? { start: match.index, prefix: match[0] } : null;
}

/**
 * Judge expression text without touching the model.
 * @param {any} data
 * @param {string} containerId
 * @param {string} text
 * @returns {{ ok: boolean, message: string, result: any, names: string[] }}
 */
export function checkExpression(data, containerId, text) {
  if (text.trim() === "" || text.trim() === "=") {
    return { ok: false, message: "Write an expression, for example Costs!B2 or IF(Total > 10, Summary, \"\").", result: null, names: [] };
  }
  const result = evaluateExpression(data, containerId, text);
  const names = result.ast ? collectNames(result.ast).map((n) => n.segments.join("!")) : [];
  if (isFormulaError(result.value)) {
    return { ok: false, message: explain(result.value).text, result, names: [...new Set(names)] };
  }
  return { ok: true, message: "", result, names: [...new Set(names)] };
}

/**
 * @param {object} options
 * @param {{ data: any }} options.workspace
 * @param {import("./popover.js").PopoverHost} options.popovers
 * @param {HTMLElement} options.anchor
 * @param {string} options.pageId Container the expression is written in.
 * @param {string} [options.initial]
 * @param {string} [options.confirm] Label of the apply button.
 * @param {(text: string) => boolean | void} options.onSubmit Return false to keep the editor open.
 */
export function openExpressionEditor(options) {
  const { workspace, popovers, pageId } = options;
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      class: "expression-input",
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      value: options.initial ?? "",
      "aria-label": "Expression",
      placeholder: "Costs!B2 or IF(Total > 10, Summary, \"\")"
    })
  );
  const names = h("div", { class: "expression-names" });
  const suggestions = h("div", { class: "expression-suggestions", role: "listbox" });
  const result = h("div", { class: "expression-result", "data-role": "expression-result" });
  const problem = h("div", { class: "expression-problem", role: "alert", "data-role": "expression-problem" });
  const apply = /** @type {HTMLButtonElement} */ (
    h("button", { class: "button is-primary", type: "button", "data-action": "expression-apply", text: options.confirm ?? "Apply" })
  );
  let highlighted = -1;
  /** @type {{ text: string }[]} */
  let offered = [];

  function showSuggestions() {
    clear(suggestions);
    offered = [];
    highlighted = -1;
    const word = wordBeforeCaret(input.value, input.selectionStart ?? input.value.length);
    if (!word) return;
    offered = suggestNames(workspace.data, pageId, word.prefix).slice(0, MAX_SUGGESTIONS);
    offered.forEach((item, index) => {
      const row = h("button", {
        class: "expression-suggestion",
        type: "button",
        role: "option",
        "data-kind": /** @type {any} */ (item).kind,
        text: item.text
      });
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => accept(index));
      suggestions.append(row);
    });
  }

  /** @param {number} index */
  function accept(index) {
    const item = offered[index];
    if (!item) return;
    const caret = input.selectionStart ?? input.value.length;
    const word = wordBeforeCaret(input.value, caret);
    if (!word) return;
    input.value = input.value.slice(0, word.start) + item.text + input.value.slice(caret);
    const next = word.start + item.text.length;
    input.setSelectionRange(next, next);
    input.focus();
    update();
  }

  function mark() {
    for (const [index, row] of [...suggestions.children].entries()) row.classList.toggle("is-highlighted", index === highlighted);
  }

  function update() {
    const state = checkExpression(workspace.data, pageId, input.value);
    clear(names);
    state.names.forEach((name, index) => {
      names.append(h("span", { class: `expression-name is-ref-${(index % PALETTE_SIZE) + 1}`, text: `${index + 1} ${name}` }));
    });
    clear(result);
    if (state.result && state.ok) {
      const data = workspace.data;
      result.append(renderValue({ data, engines: enginesFor(data) }, state.result.value));
    }
    problem.textContent = input.value.trim() === "" ? "" : state.message;
    apply.disabled = !state.ok;
    showSuggestions();
  }

  function submit() {
    if (apply.disabled) return;
    if (options.onSubmit(input.value) === false) return;
    popovers.close();
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && offered.length > 0) {
      event.preventDefault();
      highlighted = (highlighted + 1) % offered.length;
      mark();
    } else if (event.key === "ArrowUp" && offered.length > 0) {
      event.preventDefault();
      highlighted = (highlighted - 1 + offered.length) % offered.length;
      mark();
    } else if (event.key === "Tab" && offered.length > 0) {
      event.preventDefault();
      accept(highlighted >= 0 ? highlighted : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlighted >= 0) accept(highlighted);
      else submit();
    } else if (event.key === "Escape") {
      popovers.close();
    }
    event.stopPropagation();
  });
  apply.addEventListener("click", submit);

  const form = h("div", { class: "expression-editor" }, [
    h("div", { class: "name-prompt-title", text: "Expression" }),
    input,
    suggestions,
    names,
    result,
    problem,
    h("div", { class: "name-prompt-actions" }, [apply])
  ]);
  popovers.show(options.anchor, form, { keepFocus: true, class: "expression-popover" });
  update();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
