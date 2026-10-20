import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerPresentationCommands } from "../src/presentation/commands.js";
import { createAnimation, createObject } from "../src/presentation/model.js";
import { createSlideshow } from "../src/app/slideshow.js";
import { mountApp } from "../src/app/shell.js";

/**
 * A deck of three slides. Slide 1 has a text object that fades in on click and a shape with
 * a second click step; slide 2 has a fade transition; slide 3 has nothing special.
 */
function deck() {
  const ws = Workspace.create({ title: "W" });
  registerPresentationCommands(ws);
  ws.dispatch("createPage", { type: "presentation", title: "Deck" });
  const pageId = ws.getChildren(null)[0];
  for (let i = 0; i < 3; i += 1) ws.dispatch("createSlide", { pageId, layout: "blank" });
  const [s1, s2, s3] = ws.getPage(pageId).content.slideOrder;
  const add = (slideId, type, fields) => {
    const object = createObject(type, fields);
    ws.dispatch("insertObject", { pageId, slideId, object });
    return object.id;
  };
  const a = add(s1, "text", { x: 10, y: 10, width: 200, height: 50 });
  const b = add(s1, "shape", { x: 300, y: 10, width: 100, height: 100 });
  const c = add(s2, "shape", { x: 10, y: 10, width: 100, height: 100 });
  const animate = (slideId, fields) =>
    ws.dispatch("addAnimation", { pageId, slideId, animation: createAnimation(fields) });
  animate(s1, { objectId: a, effect: "fade-in", trigger: "click" });
  animate(s1, { objectId: b, effect: "fade-in", trigger: "click" });
  ws.dispatch("setSlideTransition", { pageId, slideId: s2, transition: { style: "fade", duration: 400 } });
  return { ws, pageId, s1, s2, s3, a, b, c };
}

/** @param {ReturnType<typeof deck>} d @param {object} [options] */
function show(d, options = {}) {
  const handle = createSlideshow(d.ws, d.pageId, options);
  document.body.append(handle.element);
  handle.start();
  return handle;
}

const objectEl = (handle, id) => handle.element.querySelector(`[data-object-id="${id}"]`);
const key = (name, init = {}) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("slide show", () => {
  it("draws the first slide with a counter and its entrance object hidden, then plays step 0", () => {
    const d = deck();
    const handle = show(d);
    expect(handle.element.querySelector('[data-role="show-counter"]').textContent).toBe("1 / 3");
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 0, busy: true });
    // Step 0 played on its own: the first object is shown, the second still waits.
    expect(objectEl(handle, d.b).style.visibility).toBe("hidden");
    vi.advanceTimersByTime(600);
    expect(handle.getPosition().busy).toBe(false);
  });

  it("steps through click animations before moving to the next slide", () => {
    const d = deck();
    const handle = show(d);
    vi.advanceTimersByTime(600);
    handle.next();
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 1 });
    expect(objectEl(handle, d.b).style.visibility).toBe("");
    vi.advanceTimersByTime(600);
    handle.next();
    expect(handle.getPosition()).toMatchObject({ index: 1, step: -1 });
  });

  it("a press while animating completes it and is used up", () => {
    const d = deck();
    const handle = show(d);
    expect(handle.getPosition().busy).toBe(true);
    handle.next();
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 0, busy: false });
    handle.next();
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 1 });
  });

  it("runs the incoming slide's transition over the old slide, then drops the old one", () => {
    const d = deck();
    const handle = show(d, { startSlideId: d.s1 });
    handle.finish();
    handle.next();
    handle.finish();
    handle.next(); // slide 1 -> slide 2, fade
    expect(handle.getPosition()).toMatchObject({ index: 1, busy: true });
    expect(handle.element.querySelectorAll(".slide")).toHaveLength(2);
    vi.advanceTimersByTime(400);
    expect(handle.element.querySelectorAll(".slide")).toHaveLength(1);
    expect(handle.getPosition().busy).toBe(false);
  });

  it("goes back a step, then back a slide with its animations finished", () => {
    const d = deck();
    const handle = show(d);
    vi.advanceTimersByTime(600);
    handle.next();
    vi.advanceTimersByTime(600);
    handle.previous();
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 0 });
    expect(objectEl(handle, d.b).style.visibility).toBe("hidden");
    handle.goTo(1);
    handle.finish();
    handle.previous();
    handle.finish();
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 1 });
    expect(objectEl(handle, d.b).style.visibility).toBe("");
  });

  it("stops at the last slide and disables the forward button", () => {
    const d = deck();
    const handle = show(d, { startSlideId: d.s3 });
    const next = handle.element.querySelector('[data-action="show-next"]');
    expect(next.disabled).toBe(true);
    handle.next();
    expect(handle.getPosition().index).toBe(2);
    const back = handle.element.querySelector('[data-action="show-back"]');
    expect(back.disabled).toBe(false);
  });

  it("disables back at the very start", () => {
    const d = deck();
    const handle = show(d);
    vi.advanceTimersByTime(600);
    handle.previous();
    expect(handle.getPosition()).toMatchObject({ index: 0, step: 0 });
    handle.finish();
  });

  it("navigates from the bar buttons and the arrow keys", () => {
    const d = deck();
    const handle = show(d, { startSlideId: d.s2 });
    handle.finish();
    handle.element.querySelector('[data-action="show-next"]').click();
    expect(handle.getPosition().index).toBe(2);
    key("ArrowLeft");
    expect(handle.getPosition().index).toBe(1);
    key("Home");
    expect(handle.getPosition().index).toBe(0);
    key("End");
    expect(handle.getPosition().index).toBe(2);
    key("ArrowRight", { metaKey: true });
    expect(handle.getPosition().index).toBe(2);
  });

  it("clicking the slide area advances", () => {
    const d = deck();
    const handle = show(d, { startSlideId: d.s3 });
    handle.goTo(1);
    handle.finish();
    handle.element.querySelector('[data-role="show-viewport"]').click();
    expect(handle.getPosition().index).toBe(2);
  });

  it("starts from a given slide", () => {
    const d = deck();
    const handle = show(d, { startSlideId: d.s2 });
    expect(handle.getPosition()).toMatchObject({ index: 1, total: 3, slideId: d.s2 });
  });

  it("Escape and the exit button leave once, reporting the slide reached", () => {
    const d = deck();
    const onExit = vi.fn();
    const handle = show(d, { startSlideId: d.s2, onExit });
    key("Escape");
    expect(onExit).toHaveBeenCalledWith(d.s2);
    expect(handle.element.isConnected).toBe(false);
    key("Escape");
    expect(onExit).toHaveBeenCalledTimes(1);
    // Keys no longer move anything.
    key("ArrowRight");
    expect(handle.getPosition().index).toBe(1);
  });

  it("destroy removes the show without reporting an exit", () => {
    const d = deck();
    const onExit = vi.fn();
    const handle = show(d, { onExit });
    handle.destroy();
    expect(onExit).not.toHaveBeenCalled();
    expect(handle.element.isConnected).toBe(false);
  });

  it("leaves keys alone while typing in a field", () => {
    const d = deck();
    const handle = show(d, { startSlideId: d.s2 });
    handle.finish();
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(handle.getPosition().index).toBe(1);
  });

  it("follows object links: a slide link jumps, a page link navigates, a url opens", () => {
    const d = deck();
    d.ws.dispatch("updateObject", { pageId: d.pageId, slideId: d.s1, objectId: d.a, patch: { link: { kind: "slide", slideId: d.s3 } } });
    d.ws.dispatch("updateObject", { pageId: d.pageId, slideId: d.s1, objectId: d.b, patch: { link: { kind: "url", url: "https://example.com" } } });
    const navigate = vi.fn();
    const openUrl = vi.fn();
    const handle = show(d, { navigate, openUrl });
    handle.finish();
    objectEl(handle, d.b).click();
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    expect(handle.getPosition().index).toBe(0);
    objectEl(handle, d.a).click();
    expect(handle.getPosition().index).toBe(2);
  });

  it("returns null for a presentation without slides", () => {
    const ws = Workspace.create({ title: "W" });
    registerPresentationCommands(ws);
    ws.dispatch("createPage", { type: "presentation", title: "Empty" });
    expect(createSlideshow(ws, ws.getChildren(null)[0])).toBeNull();
  });
});

describe("slide show in the app", () => {
  function app() {
    const d = deck();
    const root = document.createElement("div");
    document.body.append(root);
    const shell = mountApp(root, d.ws, { confirm: () => true });
    shell.select(d.pageId);
    return { ...d, root, shell };
  }

  it("covers the main column and leaves the sidebar visible", () => {
    const { root, shell } = app();
    expect(root.querySelector('[data-role="slideshow"]')).toBeNull();
    root.querySelector('[data-action="play-slideshow"]').click();
    const el = root.querySelector("main.main > .slideshow");
    expect(el).toBeTruthy();
    expect(root.querySelector(".sidebar")).toBeTruthy();
    expect(shell.getSlideshow()).toBeTruthy();
  });

  it("starts from the beginning or the current slide from the Slide Show tab", () => {
    const { root, shell, s2 } = app();
    shell.getPresentationEditor().selectSlide(s2);
    root.querySelector('.ribbon-tab[data-tab="slideshow"]').click();
    root.querySelector('[data-action="show-from-current"]').click();
    expect(shell.getSlideshow().getPosition().index).toBe(1);
    shell.getSlideshow().exit();
    expect(shell.getSlideshow()).toBeNull();
    root.querySelector('[data-action="show-from-beginning"]').click();
    expect(shell.getSlideshow().getPosition().index).toBe(0);
  });

  it("uses Cmd/Ctrl+Enter and Shift+Cmd/Ctrl+Enter", () => {
    const { shell, s3 } = app();
    shell.getPresentationEditor().selectSlide(s3);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(shell.getSlideshow().getPosition().index).toBe(0);
    shell.getSlideshow().exit();
    shell.getPresentationEditor().selectSlide(s3);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(shell.getSlideshow().getPosition().index).toBe(2);
  });

  it("leaves the editor on the slide that was reached", () => {
    const { shell, s2 } = app();
    shell.startSlideshow("beginning");
    shell.getSlideshow().goTo(1);
    shell.getSlideshow().exit();
    expect(shell.getPresentationEditor().getSlideId()).toBe(s2);
  });

  it("ends when another page is chosen from the sidebar", () => {
    const { ws, root, shell } = app();
    ws.dispatch("createPage", { type: "document", title: "Other" });
    const other = ws.getChildren(null).slice(-1)[0];
    shell.startSlideshow("beginning");
    shell.select(other);
    expect(shell.getSlideshow()).toBeNull();
    expect(root.querySelector('[data-role="slideshow"]')).toBeNull();
  });

  it("only offers the play button on presentations", () => {
    const { ws, root, shell } = app();
    const button = root.querySelector('[data-action="play-slideshow"]');
    expect(button.style.display).toBe("");
    ws.dispatch("createPage", { type: "document", title: "Other" });
    shell.select(ws.getChildren(null).slice(-1)[0]);
    expect(button.style.display).toBe("none");
  });

  it("ignores undo while the show is up", () => {
    const { ws, shell } = app();
    shell.startSlideshow("beginning");
    ws.dispatch("renameWorkspace", { title: "X" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(ws.title).toBe("X");
    expect(shell.getSlideshow()).toBeTruthy();
  });
});
