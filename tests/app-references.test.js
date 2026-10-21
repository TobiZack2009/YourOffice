import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { CommandError } from "../src/core/errors.js";
import { createPopoverHost } from "../src/app/popover.js";
import { guard, showNotice, clearNotice } from "../src/app/notice.js";
import { planBlockMove, promptName, referenceCount, sectionMenuItems, referenceMenuItems, describeSite } from "../src/app/handles.js";
import {
  renderBlocksSection,
  renderErrorChip,
  renderSectionById,
  renderSlideSection,
  renderTableSection,
  renderValue,
  enginesFor
} from "../src/app/reference-render.js";
import { openReferencePicker, renderPreview } from "../src/app/reference-picker.js";
import { checkExpression, openExpressionEditor, wordBeforeCaret } from "../src/app/expression-editor.js";
import { findSection } from "../src/references/sections.js";
import { buildCatalog } from "../src/references/catalog.js";
import { ERR } from "../src/calc/errors.js";

/**
 * Notes (document)  paragraphs one, two, three; section Intro = b1..b2
 * Other (document)  empty
 * Data (sheet)      table Costs with A1 = 5, A2 = 7
 * Deck (presentation) two blank slides
 */
function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (type, title) => {
    ws.dispatch("createPage", { type, title });
    const list = ws.getChildren(null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const other = page("document", "Other");
  const data = page("sheet", "Data");
  const deck = page("presentation", "Deck");
  for (const [id, text] of [["b1", "one"], ["b2", "two"], ["b3", "three"]]) {
    ws.dispatch("insertBlock", { pageId: notes, newBlockId: id, block: { type: "paragraph", runs: [{ text }] } });
  }
  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 5 } });
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 1, cell: { value: 7 } });
  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s1" });
  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s2" });
  ws.dispatch("createSection", { pageId: notes, name: "Intro", locator: { startBlockId: "b1", endBlockId: "b2" }, sectionId: "sec_intro" });
  return { ws, notes, other, data, deck, costs };
}

function host() {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  return { anchor, popovers: createPopoverHost(document.body) };
}

afterEach(() => {
  clearNotice();
  document.body.replaceChildren();
});

describe("planBlockMove", () => {
  const order = ["a", "b", "c", "d"];

  it("moves one block after a target", () => {
    expect(planBlockMove(order, ["a"], "c", "after")).toEqual({ blockIds: ["a"], afterBlockId: "c" });
  });

  it("moves a run before a target and keeps document order", () => {
    expect(planBlockMove(order, ["c", "b"], "a", "before")).toEqual({ blockIds: ["b", "c"], beforeBlockId: "a" });
  });

  it("is null when nothing would change", () => {
    expect(planBlockMove(order, ["b"], "a", "after")).toBeNull();
    expect(planBlockMove(order, ["b"], "c", "before")).toBeNull();
  });

  it("is null when the target is being moved or unknown", () => {
    expect(planBlockMove(order, ["a", "b"], "b", "after")).toBeNull();
    expect(planBlockMove(order, ["a"], "zzz", "after")).toBeNull();
    expect(planBlockMove(order, ["zzz"], "a", "after")).toBeNull();
    expect(planBlockMove(order, [], "a", "after")).toBeNull();
  });
});

describe("notice and guard", () => {
  it("shows one notice at a time", () => {
    showNotice("first");
    showNotice("second");
    const notices = document.querySelectorAll(".app-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toBe("second");
  });

  it("turns a refused command into a notice", () => {
    const refused = vi.fn();
    const ok = guard(() => {
      throw new CommandError("Not allowed.", "nope");
    }, refused);
    expect(ok).toBe(false);
    expect(refused).toHaveBeenCalledOnce();
    expect(document.querySelector(".app-notice")?.textContent).toBe("Not allowed.");
  });

  it("lets other errors through and reports success", () => {
    expect(guard(() => {})).toBe(true);
    expect(() =>
      guard(() => {
        throw new TypeError("bug");
      })
    ).toThrow("bug");
  });

  it("clears itself on demand", () => {
    showNotice("x");
    clearNotice();
    expect(document.querySelector(".app-notice")).toBeNull();
  });
});

describe("promptName", () => {
  it("submits a trimmed name and closes", () => {
    const { anchor, popovers } = host();
    const onSubmit = vi.fn();
    promptName(popovers, anchor, { title: "Section name", onSubmit });
    const input = document.querySelector(".name-prompt-input");
    input.value = "  Totals ";
    document.querySelector("[data-action=name-confirm]").click();
    expect(onSubmit).toHaveBeenCalledWith("Totals");
    expect(document.querySelector(".name-prompt")).toBeNull();
  });

  it("refuses an empty name and stays open", () => {
    const { anchor, popovers } = host();
    const onSubmit = vi.fn();
    promptName(popovers, anchor, { title: "Section name", onSubmit });
    document.querySelector("[data-action=name-confirm]").click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector(".name-prompt-input").classList.contains("is-invalid")).toBe(true);
  });

  it("stays open when the callback returns false", () => {
    const { anchor, popovers } = host();
    promptName(popovers, anchor, { title: "Name", onSubmit: () => false });
    document.querySelector(".name-prompt-input").value = "x";
    document.querySelector("[data-action=name-confirm]").click();
    expect(document.querySelector(".name-prompt")).not.toBeNull();
  });
});

describe("section and reference menus", () => {
  it("counts references on a section", () => {
    const { ws, other } = setup();
    expect(referenceCount(ws, "sec_intro")).toBe(0);
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    expect(referenceCount(ws, "sec_intro")).toBe(1);
  });

  it("offers rename, show references and remove for a section", () => {
    const { ws } = setup();
    const { anchor, popovers } = host();
    const items = sectionMenuItems({ workspace: ws, popovers, anchor: () => anchor, sectionId: "sec_intro" });
    expect(items.map((item) => item.attrs["data-action"])).toEqual(["section-rename", "section-references", "section-remove"]);
    expect(items[1].label).toBe("Show references (0)");
  });

  it("renames a section through the menu", () => {
    const { ws, notes } = setup();
    const { anchor, popovers } = host();
    const items = sectionMenuItems({ workspace: ws, popovers, anchor: () => anchor, sectionId: "sec_intro" });
    items[0].action();
    document.querySelector(".name-prompt-input").value = "Opening";
    document.querySelector("[data-action=name-confirm]").click();
    expect(ws.getPage(notes).content.sections.sec_intro.name).toBe("Opening");
  });

  it("lists readers and describes them", () => {
    const { ws, other } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const { anchor, popovers } = host();
    const navigate = vi.fn();
    const items = sectionMenuItems({ workspace: ws, popovers, anchor: () => anchor, sectionId: "sec_intro", navigate });
    expect(items[1].label).toBe("Show references (1)");
    items[1].action();
    const row = document.querySelector(".reference-list-row");
    expect(row.textContent).toBe("Other: embed");
    row.click();
    expect(navigate).toHaveBeenCalledWith(other);
  });

  it("explains an unread section in the list", () => {
    const { ws } = setup();
    const { anchor, popovers } = host();
    sectionMenuItems({ workspace: ws, popovers, anchor: () => anchor, sectionId: "sec_intro" })[1].action();
    expect(document.querySelector(".reference-list-empty")?.textContent).toBe("Nothing refers to this yet.");
  });

  it("offers source, replace and remove for an embed", () => {
    const { ws, other } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const block = Object.values(ws.getPage(other).content.blocks)[0];
    const { anchor, popovers } = host();
    const items = referenceMenuItems({
      workspace: ws,
      popovers,
      anchor: () => anchor,
      hostId: other,
      record: block,
      replaceSource: () => {}
    });
    expect(items.filter((i) => !i.separator).map((i) => i.attrs["data-action"])).toEqual([
      "reference-go",
      "reference-replace",
      "reference-remove"
    ]);
  });

  it("offers restore (not go-to) once the source is detached, and removing drops the reference", () => {
    const { ws, other, notes } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    ws.dispatch("deletePage", { pageId: notes });
    const block = Object.values(ws.getPage(other).content.blocks)[0];
    expect(findSection(ws.data, "sec_intro")?.detached).toBe(true);
    const { anchor, popovers } = host();
    const items = referenceMenuItems({ workspace: ws, popovers, anchor: () => anchor, hostId: other, record: block });
    const actions = items.filter((i) => !i.separator).map((i) => i.attrs["data-action"]);
    expect(actions).toContain("reference-restore");
    expect(actions).not.toContain("reference-go");
    items.find((i) => i.attrs?.["data-action"] === "reference-remove").action();
    expect(ws.getPage(other).content.blockOrder).toHaveLength(0);
    expect(Object.keys(ws.data.detached ?? {})).toHaveLength(0);
  });

  it("offers edit and remove for an expression", () => {
    const { ws, other } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1", display: {} });
    const block = Object.values(ws.getPage(other).content.blocks)[0];
    const { anchor, popovers } = host();
    const items = referenceMenuItems({ workspace: ws, popovers, anchor: () => anchor, hostId: other, record: block });
    expect(items.map((i) => i.attrs["data-action"])).toEqual(["reference-edit", "reference-remove"]);
  });

  it("describes a formula reader by table and cell", () => {
    const { ws, data, other } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1", display: {} });
    expect(describeSite(ws.data, { containerId: other, source: "expression" })).toBe("Other: expression");
    const tableId = ws.getPage(data).content.tableOrder[0];
    expect(describeSite(ws.data, { containerId: data, source: "formula", tableId, position: { col: 1, row: 2 } })).toBe(
      "Data: formula in Costs B3"
    );
  });
});

describe("reference rendering", () => {
  it("draws a section's blocks read-only", () => {
    const { ws } = setup();
    const found = findSection(ws.data, "sec_intro");
    const el = renderBlocksSection({ data: ws.data }, found);
    expect(el.className).toBe("reference-blocks");
    expect([...el.children].map((c) => c.textContent)).toEqual(["one", "two"]);
    expect(el.querySelector("[contenteditable]")).toBeNull();
  });

  it("draws a table section with its computed cells and no position", () => {
    const { ws, data } = setup();
    ws.dispatch("createSection", { pageId: data, locator: { tableId: ws.getPage(data).content.tableOrder[0] }, implicit: true, sectionId: "sec_t" });
    const el = renderSectionById({ data: ws.data }, "sec_t");
    expect(el.className).toBe("reference-table");
    expect(el.querySelector(".sheet-table").style.left).toBe("");
    expect(el.textContent).toContain("5");
  });

  it("hides cells outside a range section", () => {
    const { ws, data, costs } = setup();
    ws.dispatch("createSection", {
      pageId: data,
      name: "First",
      locator: { tableId: costs, range: { start: { col: 0, row: 0 }, end: { col: 0, row: 0 } } },
      sectionId: "sec_r"
    });
    const el = renderTableSection({ data: ws.data }, findSection(ws.data, "sec_r"));
    const cells = [...el.querySelectorAll("td.sheet-cell")];
    const isHidden = (td) => td.style.display === "none" || td.parentElement.style.display === "none";
    expect(cells.filter((td) => !isHidden(td)).map((td) => td.getAttribute("data-key"))).toEqual(["0,0"]);
    expect(cells.some(isHidden)).toBe(true);
  });

  it("draws a slide at the requested width", () => {
    const { ws, deck } = setup();
    ws.dispatch("createSection", { pageId: deck, locator: { slideId: "s1" }, implicit: true, sectionId: "sec_s" });
    const el = renderSlideSection({ data: ws.data }, findSection(ws.data, "sec_s"), 320);
    expect(el.className).toBe("reference-slide");
    expect(el.style.width).toBe("320px");
    expect(el.getAttribute("data-slide-id")).toBe("s1");
  });

  it("says so when the source is gone", () => {
    const { ws } = setup();
    expect(renderSectionById({ data: ws.data }, "nope").className).toBe("reference-missing");
    expect(renderSectionById({ data: ws.data }, undefined).textContent).toBe("The source was removed.");
  });

  it("draws values: scalar, empty, error and block handles", () => {
    const { ws } = setup();
    const ctx = { data: ws.data, engines: enginesFor(ws.data) };
    expect(renderValue(ctx, 12).textContent).toBe("12");
    expect(renderValue(ctx, "").className).toBe("reference-empty");
    expect(renderValue(ctx, null).className).toBe("reference-empty");
    const chip = renderValue(ctx, ERR.REF);
    expect(chip.classList.contains("is-error")).toBe(true);
    expect(chip.getAttribute("data-error")).toBe("#REF!");
    expect(chip.title).not.toBe("");
    expect(renderValue(ctx, { kind: "blocks", sectionId: "sec_intro" }).className).toBe("reference-blocks");
  });

  it("gives an error chip a plain-language explanation", () => {
    const chip = renderErrorChip(ERR.NAME);
    expect(chip.getAttribute("data-explanation")).toBe(chip.title);
    expect(chip.getAttribute("aria-label")).toContain("#NAME?");
  });
});

describe("reference picker", () => {
  it("previews each kind of catalog item", () => {
    const { ws, data, deck } = setup();
    const items = buildCatalog(ws.data).flatMap((p) => p.items);
    const table = items.find((i) => i.kind === "table");
    const slide = items.find((i) => i.kind === "slide");
    const section = items.find((i) => i.kind === "section" && i.pageId !== data);
    expect(renderPreview(ws.data, table).className).toBe("reference-table");
    expect(renderPreview(ws.data, slide).className).toBe("reference-slide");
    expect(renderPreview(ws.data, section).className).toBe("reference-blocks");
    expect(deck).toBeTruthy();
  });

  it("lists pages and their contents, and filters by search", () => {
    const { ws, notes } = setup();
    const { anchor, popovers } = host();
    openReferencePicker({ workspace: ws, popovers, anchor, pageId: notes, onPick: () => {} });
    const pages = [...document.querySelectorAll(".picker-page")].map((p) => p.textContent);
    expect(pages).toEqual(["Notes", "Other", "Data", "Deck"]);
    expect(document.querySelector('.picker-item[data-kind="table"]').textContent).toBe("Costs");
    const search = document.querySelector(".picker-search");
    search.value = "costs";
    search.dispatchEvent(new Event("input"));
    expect([...document.querySelectorAll(".picker-item")].map((i) => i.textContent)).toEqual(["Costs"]);
    search.value = "zzzz";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelector(".picker-empty")).not.toBeNull();
  });

  it("shows a live preview on hover", () => {
    const { ws, notes } = setup();
    const { anchor, popovers } = host();
    openReferencePicker({ workspace: ws, popovers, anchor, pageId: notes, onPick: () => {} });
    document.querySelector('.picker-item[data-kind="section"]').dispatchEvent(new Event("mouseenter"));
    expect(document.querySelector("[data-role=picker-preview] .reference-blocks")).not.toBeNull();
  });

  it("picks an existing section straight away and closes", () => {
    const { ws, notes } = setup();
    const { anchor, popovers } = host();
    const onPick = vi.fn();
    openReferencePicker({ workspace: ws, popovers, anchor, pageId: notes, onPick });
    document.querySelector('.picker-item[data-kind="section"]').click();
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0].sectionId).toBe("sec_intro");
    expect(document.querySelector(".reference-picker")).toBeNull();
  });

  it("asks for a name before using unsectioned blocks", () => {
    const { ws, notes } = setup();
    const { anchor, popovers } = host();
    const onPick = vi.fn();
    openReferencePicker({ workspace: ws, popovers, anchor, pageId: notes, onPick });
    document.querySelector('.picker-item[data-key="block:b3"]').click();
    expect(onPick).not.toHaveBeenCalled();
    document.querySelector("[data-action=picker-name-confirm]").click();
    expect(onPick).not.toHaveBeenCalled();
    document.querySelector(".name-prompt-input").value = "Closing";
    document.querySelector("[data-action=picker-name-confirm]").click();
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][1]).toBe("Closing");
    expect(onPick.mock.calls[0][0].key).toBe("block:b3");
  });

  it("stays open when the pick is refused", () => {
    const { ws, notes } = setup();
    const { anchor, popovers } = host();
    openReferencePicker({ workspace: ws, popovers, anchor, pageId: notes, onPick: () => false });
    document.querySelector('.picker-item[data-kind="section"]').click();
    expect(document.querySelector(".reference-picker")).not.toBeNull();
  });
});

describe("expression editor", () => {
  it("finds the word being typed", () => {
    expect(wordBeforeCaret("IF(Cos", 6)).toEqual({ start: 3, prefix: "Cos" });
    expect(wordBeforeCaret("Costs!B", 7)).toEqual({ start: 6, prefix: "B" });
    expect(wordBeforeCaret("1 + ", 4)).toBeNull();
    expect(wordBeforeCaret("'My ta", 6)).toEqual({ start: 0, prefix: "'My ta" });
  });

  it("checks an expression without touching the model", () => {
    const { ws, other } = setup();
    expect(checkExpression(ws.data, other, "").ok).toBe(false);
    expect(checkExpression(ws.data, other, "=").ok).toBe(false);
    const good = checkExpression(ws.data, other, "Data!Costs!A1 + 1");
    expect(good.ok).toBe(true);
    expect(good.result.value).toBe(6);
    expect(good.names).toEqual(["Data!Costs"]);
    const bad = checkExpression(ws.data, other, "Nope!A1");
    expect(bad.ok).toBe(false);
    expect(bad.message).not.toBe("");
  });

  function open(ws, pageId, extra = {}) {
    const { anchor, popovers } = host();
    const onSubmit = vi.fn();
    openExpressionEditor({ workspace: ws, popovers, anchor, pageId, onSubmit, confirm: "Insert", ...extra });
    const input = document.querySelector(".expression-input");
    const type = (text) => {
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input"));
    };
    return { input, type, onSubmit, apply: () => document.querySelector("[data-action=expression-apply]") };
  }

  it("starts disabled and enables once the expression works", () => {
    const { ws, other } = setup();
    const { type, apply } = open(ws, other);
    expect(apply().disabled).toBe(true);
    type("Data!Costs!A1 + Data!Costs!A2");
    expect(apply().disabled).toBe(false);
    expect(document.querySelector("[data-role=expression-result]").textContent).toBe("12");
    expect(document.querySelector(".expression-problem").textContent).toBe("");
  });

  it("explains an error and blocks the insert", () => {
    const { ws, other } = setup();
    const { type, apply, onSubmit } = open(ws, other);
    type("Nope!A1");
    expect(apply().disabled).toBe(true);
    expect(document.querySelector("[data-role=expression-problem]").textContent).not.toBe("");
    apply().click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("lists referenced names with a number and a palette class", () => {
    const { ws, other } = setup();
    const { type } = open(ws, other);
    type("Data!Costs!A1 & Data!Costs!A2 & Notes!Intro");
    const names = [...document.querySelectorAll(".expression-name")];
    expect(names.map((n) => n.textContent)).toEqual(["1 Data!Costs", "2 Notes!Intro"]);
    expect(names[0].classList.contains("is-ref-1")).toBe(true);
    expect(names[1].classList.contains("is-ref-2")).toBe(true);
  });

  it("submits the text and closes; stays open when refused", () => {
    const { ws, other } = setup();
    const first = open(ws, other);
    first.type("Data!Costs!A1");
    first.apply().click();
    expect(first.onSubmit).toHaveBeenCalledWith("Data!Costs!A1");
    expect(document.querySelector(".expression-editor")).toBeNull();

    const second = open(ws, other, { onSubmit: () => false });
    second.type("Data!Costs!A1");
    second.apply().click();
    expect(document.querySelector(".expression-editor")).not.toBeNull();
  });

  it("suggests names and accepts one with Tab", () => {
    const { ws, other } = setup();
    const { input, type } = open(ws, other);
    type("Dat");
    const suggestions = [...document.querySelectorAll(".expression-suggestion")].map((s) => s.textContent);
    expect(suggestions.some((s) => s.startsWith("Data"))).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(input.value.startsWith("Data")).toBe(true);
  });

  it("opens with an initial expression already judged", () => {
    const { ws, other } = setup();
    const { apply } = open(ws, other, { initial: "Data!Costs!A2" });
    expect(apply().disabled).toBe(false);
    expect(document.querySelector("[data-role=expression-result]").textContent).toBe("7");
  });
});
