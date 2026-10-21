/**
 * Slide show: plays a presentation inside the main column (the sidebar stays), with a
 * persistent bar of back / forward buttons, a position counter, fullscreen and exit.
 *
 * The show only reads the model. It draws slides with the same `renderSlide` the
 * editor uses (read-only), steps through each slide's click animations, and runs the
 * slide's stored transition between slides. Where to go next, what a slide looks like
 * part-way through and how a transition moves are pure functions in
 * `presentation/slideshow.js`; this file owns the DOM, timers and Web Animations.
 *
 * A press while something is still animating completes it and is used up, so the
 * next press always means "go on".
 */

import { hasTransition, lastStep, nextPosition, previousPosition, settledAt, stepEntries, stepLength, transitionBetween, transitionKeyframes } from "../presentation/slideshow.js";
import { fitScale } from "../presentation/geometry.js";
import { readPresentationContent } from "../presentation/model.js";
import { renderSlide } from "../presentation/render.js";
import { buildBook } from "../references/table-engine.js";
import { playAnimation } from "./animation-preview.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { pageIdOfLink } from "./link-form.js";
import { enginesFor, staticReferenceHooks } from "../export/static-render.js";
import { pageContent, pageExists, pageTitle } from "../workspace/selectors.js";

/**
 * @typedef {object} SlideshowOptions
 * @property {string | null} [startSlideId] Where to begin; the first slide when absent.
 * @property {(slideId: string) => void} [onExit] Called once when the presenter leaves
 *   (with the slide that was showing). Not called by `destroy()`.
 * @property {(pageId: string) => void} [navigate] A link to another page was clicked.
 * @property {(assetId: string) => string | undefined} [resolveAssetUrl] Where image assets are shown from.
 * @property {(url: string) => void} [openUrl] Opens a web link (defaults to a new tab).
 *
 * @typedef {object} SlideshowHandle
 * @property {HTMLElement} element
 * @property {() => void} start Draw the first slide. Call once the element is in the document, so sizes exist.
 * @property {() => void} next
 * @property {() => void} previous
 * @property {(index: number) => void} goTo
 * @property {() => boolean} finish Complete whatever is animating; true when something was.
 * @property {() => { index: number, step: number, total: number, busy: boolean, slideId: string }} getPosition
 * @property {() => void} toggleFullscreen
 * @property {() => void} focus
 * @property {() => void} exit
 * @property {() => void} destroy
 */

/** Upper bound for the scale so a small slide is not blown up absurdly on a huge window. */
const MAX_SCALE = 6;

/**
 * Keyboard actions while the show is up.
 * @type {Record<string, "next" | "previous" | "first" | "last" | "exit" | "fullscreen">}
 */
const KEYS = {
  ArrowRight: "next",
  ArrowDown: "next",
  PageDown: "next",
  " ": "next",
  Enter: "next",
  n: "next",
  ArrowLeft: "previous",
  ArrowUp: "previous",
  PageUp: "previous",
  Backspace: "previous",
  p: "previous",
  Home: "first",
  End: "last",
  Escape: "exit",
  f: "fullscreen"
};

/**
 * @param {import("../workspace/store.js").Workspace} workspace
 * @param {string} pageId
 * @param {SlideshowOptions} [options]
 * @returns {SlideshowHandle | null} null when the presentation has no slides.
 */
export function createSlideshow(workspace, pageId, options = {}) {
  if (!pageExists(workspace, pageId)) return null;
  const content = readPresentationContent(pageContent(workspace, pageId), pageId);
  const order = content.slideOrder.filter((id) => content.slides[id]);
  if (order.length === 0) return null;
  const size = content.size;
  const slideAt = (/** @type {number} */ i) => content.slides[order[i]];

  const doc = document;
  const win = doc.defaultView ?? window;

  // -- references: drawn read-only, built on first use ------------------------------------
  /** @type {{ renderReference: (o: any) => HTMLElement, renderInlineRef: (r: any) => HTMLElement } | null} */
  let hooks = null;
  function slideHooks() {
    if (!hooks) {
      const data = workspace.data;
      /** @type {any} */
      let engines = null;
      /** @type {any} */
      let book = null;
      const ctx = {
        data,
        get engines() {
          return (engines ??= enginesFor(data));
        },
        get book() {
          return (book ??= buildBook(data));
        },
        resolvePageTitle: (/** @type {string} */ id) => pageTitle(workspace, id),
        resolveAssetUrl: options.resolveAssetUrl
      };
      hooks = staticReferenceHooks(/** @type {any} */ (ctx), pageId, 1);
    }
    return hooks;
  }

  // -- DOM -------------------------------------------------------------------------------

  const stage = h("div", { class: "slideshow-stage", "data-role": "show-stage" });
  const viewport = h("div", { class: "slideshow-viewport", "data-role": "show-viewport" }, [stage]);
  const counter = h("span", { class: "slideshow-counter", "data-role": "show-counter", "aria-live": "polite" });
  const backButton = barButton("show-back", "back", "Previous (Left arrow)");
  const nextButton = barButton("show-next", "forward", "Next (Right arrow, Space)");
  const fullscreenButton = barButton("show-fullscreen", "fullscreen", "Fullscreen (F)");
  const exitButton = barButton("show-exit", "close", "End show (Esc)");
  const bar = h("div", { class: "slideshow-bar", "data-role": "show-bar" }, [
    h("div", { class: "slideshow-nav" }, [backButton, counter, nextButton]),
    h("div", { class: "slideshow-bar-end" }, [fullscreenButton, exitButton])
  ]);
  const root = h(
    "div",
    { class: "slideshow", "data-role": "slideshow", tabindex: "-1", role: "region", "aria-label": "Slide show" },
    [viewport, bar]
  );

  /**
   * @param {string} action
   * @param {string} iconName
   * @param {string} title
   */
  function barButton(action, iconName, title) {
    return h("button", { class: "slideshow-button", type: "button", "data-action": action, title, "aria-label": title }, [
      icon(iconName, { size: 18 })
    ]);
  }

  // -- state ------------------------------------------------------------------------------

  let index = Math.max(0, options.startSlideId ? order.indexOf(options.startSlideId) : 0);
  let step = -1;
  let scale = 1;
  let ended = false;
  /** @type {HTMLElement | null} */
  let slideEl = null;
  /** @type {Map<string, HTMLElement>} */
  let objectEls = new Map();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /** @type {{ cancel: () => void }[]} */
  const running = [];
  /** @type {{ kind: "step" | "transition", finish: (auto: boolean) => void } | null} */
  let busy = null;

  /**
   * @param {() => void} fn
   * @param {number} ms
   */
  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  function cancelRunning() {
    for (const animation of running) animation.cancel();
    running.length = 0;
  }

  // -- drawing ----------------------------------------------------------------------------

  function computeScale() {
    const available = { width: viewport.clientWidth, height: viewport.clientHeight };
    return Math.min(MAX_SCALE, fitScale(available, size));
  }

  function applyScale() {
    scale = computeScale();
    stage.style.width = `${Math.round(size.width * scale)}px`;
    stage.style.height = `${Math.round(size.height * scale)}px`;
    for (const el of Array.from(stage.children)) {
      /** @type {HTMLElement} */ (el).style.transform = `scale(${scale})`;
    }
  }

  /**
   * @param {HTMLElement} el A drawn slide.
   * @returns {Map<string, HTMLElement>}
   */
  function objectsOf(el) {
    /** @type {Map<string, HTMLElement>} */
    const map = new Map();
    for (const child of Array.from(el.children)) {
      const id = /** @type {HTMLElement} */ (child).dataset.objectId;
      if (id) map.set(id, /** @type {HTMLElement} */ (child));
    }
    return map;
  }

  /**
   * Put a slide's objects in the state they have once steps up to `upTo` have played.
   * @param {Map<string, HTMLElement>} els
   * @param {import("../presentation/model.js").Slide} slide
   * @param {number} upTo
   */
  function applySettled(els, slide, upTo) {
    const { hidden, translate } = settledAt(slide, upTo);
    for (const [id, el] of els) {
      el.style.visibility = hidden.has(id) ? "hidden" : "";
      const move = translate.get(id);
      el.style.translate = move ? `${move.x}px ${move.y}px` : "";
    }
  }

  // -- the bar ----------------------------------------------------------------------------

  function updateBar() {
    counter.textContent = `${index + 1} / ${order.length}`;
    const slide = slideAt(index);
    const atStart = index === 0 && step <= 0;
    const atEnd = nextPosition(order.length, { index, step }, lastStep(slide)).action === "none";
    backButton.disabled = atStart;
    nextButton.disabled = atEnd && !busy;
    root.dataset.index = String(index);
    root.dataset.step = String(step);
    root.classList.toggle("is-busy", busy !== null);
    root.classList.toggle("is-last", atEnd);
  }

  // -- playing a slide's steps ------------------------------------------------------------

  /** @param {number} n */
  function playStep(n) {
    const slide = slideAt(index);
    step = n;
    const entries = stepEntries(slide, n);
    const length = stepLength(entries);
    const settleStep = () => {
      busy = null;
      updateBar();
    };
    /** @param {string} animationId */
    const run = (animationId) => {
      const animation = slide.animations[animationId];
      const object = animation && slide.objects[animation.objectId];
      const el = animation && objectEls.get(animation.objectId);
      if (!animation || !object || !el) return;
      const handle = playAnimation(el, animation, object, size);
      if (handle) running.push(handle);
    };
    for (const entry of entries) {
      if (entry.start <= 0) run(entry.id);
      else later(() => run(entry.id), entry.start);
    }
    if (length <= 0) {
      settleStep();
      return;
    }
    busy = {
      kind: "step",
      finish: () => {
        clearTimers();
        cancelRunning();
        applySettled(objectEls, slide, n);
        busy = null;
      }
    };
    later(settleStep, length);
    updateBar();
  }

  /**
   * Draw `newIndex` at `newStep`, over the current slide when a transition plays.
   * @param {number} newIndex
   * @param {number} newStep
   * @param {import("../presentation/model.js").Transition | null} transition
   */
  function enter(newIndex, newStep, transition) {
    finishBusy(false);
    const slide = slideAt(newIndex);
    const incoming = renderSlide(slide, { size, scale, ...slideHooks() });
    const incomingObjects = objectsOf(incoming);
    applySettled(incomingObjects, slide, newStep);
    const outgoing = slideEl;
    index = newIndex;
    step = newStep;
    slideEl = incoming;
    objectEls = incomingObjects;
    stage.append(incoming);

    const arrive = () => {
      if (step === -1 && lastStep(slide) >= 0) playStep(0);
      else updateBar();
    };

    const keyframes = transition && hasTransition(transition) && outgoing ? transitionKeyframes(transition) : [];
    if (!outgoing || keyframes.length === 0 || !transition) {
      outgoing?.remove();
      arrive();
      return;
    }
    /** @type {{ cancel: () => void } | null} */
    const motion = typeof incoming.animate === "function"
      ? incoming.animate(keyframes, { duration: transition.duration, easing: "ease-in-out", fill: "both" })
      : null;
    const cleanup = () => {
      clearTimers();
      motion?.cancel();
      outgoing.remove();
    };
    busy = {
      kind: "transition",
      finish: (auto) => {
        cleanup();
        busy = null;
        if (auto) arrive();
      }
    };
    later(() => {
      cleanup();
      busy = null;
      arrive();
    }, transition.duration);
    updateBar();
  }

  /**
   * Complete whatever is animating.
   * @param {boolean} auto Whether a finished transition goes on to play the slide's first step.
   * @returns {boolean} true when something was running
   */
  function finishBusy(auto) {
    if (!busy) return false;
    const current = busy;
    busy = null;
    current.finish(auto);
    updateBar();
    return true;
  }

  // -- navigation -------------------------------------------------------------------------

  function next() {
    if (ended) return;
    if (finishBusy(true)) return;
    const slide = slideAt(index);
    const result = nextPosition(order.length, { index, step }, lastStep(slide));
    if (result.action === "step") playStep(result.position.step);
    else if (result.action === "slide") {
      enter(result.position.index, -1, transitionBetween(slide, slideAt(result.position.index), true));
    } else updateBar();
  }

  function previous() {
    if (ended) return;
    finishBusy(false);
    const slide = slideAt(index);
    const previousLast = index > 0 ? lastStep(slideAt(index - 1)) : -1;
    const result = previousPosition({ index, step }, previousLast);
    if (result.action === "settle") {
      step = result.position.step;
      clearTimers();
      cancelRunning();
      applySettled(objectEls, slide, step);
      updateBar();
    } else if (result.action === "slide") {
      enter(result.position.index, result.position.step, transitionBetween(slide, slideAt(result.position.index), false));
    }
  }

  /** @param {number} target */
  function goTo(target) {
    if (ended || target < 0 || target >= order.length) return;
    if (target === index && step === -1 && !busy) return;
    enter(target, -1, null);
  }

  // -- fullscreen -------------------------------------------------------------------------

  const isFullscreen = () => doc.fullscreenElement === root;

  function toggleFullscreen() {
    if (isFullscreen()) void doc.exitFullscreen?.();
    else void root.requestFullscreen?.();
  }

  function onFullscreenChange() {
    fullscreenButton.classList.toggle("is-on", isFullscreen());
    const label = isFullscreen() ? "Leave fullscreen (F)" : "Fullscreen (F)";
    fullscreenButton.title = label;
    fullscreenButton.setAttribute("aria-label", label);
    fullscreenButton.replaceChildren(icon(isFullscreen() ? "fullscreen-exit" : "fullscreen", { size: 18 }));
    applyScale();
  }

  // -- links and clicks -------------------------------------------------------------------

  /** @param {string} url */
  function openUrl(url) {
    if (options.openUrl) return options.openUrl(url);
    let parsed;
    try {
      parsed = new URL(url, win.location.href);
    } catch {
      return;
    }
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) win.open(parsed.href, "_blank", "noopener,noreferrer");
  }

  /** @param {MouseEvent} event */
  function onViewportClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const anchor = target.closest?.("a[href]");
    if (anchor) {
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      const linked = pageIdOfLink(href);
      if (linked) options.navigate?.(linked);
      else openUrl(href);
      return;
    }
    const objectEl = /** @type {HTMLElement | null} */ (target.closest?.(".slide-object") ?? null);
    const link = objectEl && slideAt(index).objects[objectEl.dataset.objectId ?? ""]?.link;
    if (link) {
      if (link.kind === "url") openUrl(link.url);
      else if (link.kind === "page") options.navigate?.(link.pageId);
      else goTo(order.indexOf(link.slideId));
      return;
    }
    next();
  }

  // -- keyboard ---------------------------------------------------------------------------

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = /** @type {HTMLElement | null} */ (event.target);
    const typing = target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable);
    const action = KEYS[event.key] ?? KEYS[event.key?.toLowerCase()];
    if (!action || (typing && action !== "exit")) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "next") next();
    else if (action === "previous") previous();
    else if (action === "first") goTo(0);
    else if (action === "last") goTo(order.length - 1);
    else if (action === "fullscreen") toggleFullscreen();
    else exit();
  }

  // Space activates a focused button on key-up even when key-down was cancelled.
  /** @param {KeyboardEvent} event */
  function onKeyup(event) {
    if (event.key === " " && !event.metaKey && !event.ctrlKey) event.preventDefault();
  }

  // -- lifecycle --------------------------------------------------------------------------

  viewport.addEventListener("click", (event) => onViewportClick(/** @type {MouseEvent} */ (event)));
  backButton.addEventListener("click", () => previous());
  nextButton.addEventListener("click", () => next());
  fullscreenButton.addEventListener("click", () => toggleFullscreen());
  exitButton.addEventListener("click", () => exit());
  // Clicking the bar must not pull focus off the show, or the keys would stop working.
  bar.addEventListener("mousedown", (event) => event.preventDefault());
  doc.addEventListener("keydown", onKeydown, true);
  doc.addEventListener("keyup", onKeyup, true);
  doc.addEventListener("fullscreenchange", onFullscreenChange);
  win.addEventListener("resize", applyScale);
  /** @type {ResizeObserver | null} */
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => applyScale()) : null;
  observer?.observe(viewport);

  function destroy() {
    if (ended) return;
    ended = true;
    clearTimers();
    cancelRunning();
    busy = null;
    doc.removeEventListener("keydown", onKeydown, true);
    doc.removeEventListener("keyup", onKeyup, true);
    doc.removeEventListener("fullscreenchange", onFullscreenChange);
    win.removeEventListener("resize", applyScale);
    observer?.disconnect();
    if (isFullscreen()) void doc.exitFullscreen?.();
    root.remove();
  }

  function exit() {
    if (ended) return;
    const slideId = order[index];
    destroy();
    options.onExit?.(slideId);
  }

  return {
    element: root,
    next,
    previous,
    goTo,
    finish: () => finishBusy(true),
    getPosition: () => ({ index, step, total: order.length, busy: busy !== null, slideId: order[index] }),
    toggleFullscreen,
    focus: () => root.focus({ preventScroll: true }),
    exit,
    destroy,
    start() {
      applyScale();
      enter(index, -1, null);
    }
  };
}
