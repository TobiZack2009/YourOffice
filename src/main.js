/**
 * Vite entry: find the page's root element and boot the app into it.
 */

// @ts-ignore: a side-effect stylesheet import; Vite resolves it, tsc has no module for it.
import "./styles/index.css";
import { createSession } from "./app/session.js";
import { boot } from "./boot.js";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app element");

/** @returns {Pick<Storage, "getItem" | "setItem">} localStorage, or an inert stand-in when blocked. */
function localStore() {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

/** Zoom, sidebar and ribbon preferences survive a reload; ids in it are checked on use. */
function openSession() {
  try {
    return createSession({}, { storage: window.localStorage, key: "yourOffice.session" });
  } catch {
    return createSession();
  }
}

void boot({ root, session: openSession(), pointerStore: localStore() });
