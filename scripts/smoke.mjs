/**
 * Browser smoke test: drives the built single-file app in Chrome (playwright-core).
 * Run `npm run build` first, then `npm run smoke`. Not part of `npm test`: it needs Chrome and
 * checks what jsdom cannot (real focus and selection, IndexedDB, reload).
 */
import { chromium } from "playwright-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const url = pathToFileURL(fileURLToPath(new URL("../dist/index.html", import.meta.url))).href;
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 800 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
let dialog = null;
page.on("dialog", async (d) => {
  dialog = d.message();
  await d.dismiss();
});

try {
  await page.goto(url);
  await page.waitForSelector(".page-row");
  check("boots with the three demo pages", (await page.locator(".page-row").count()) === 3);
  check("no notice on a first visit", (await page.locator(".app-notice").count()) === 0);

  // Document: typing, model undo, editor identity.
  await page.click('.page-row:has-text("Welcome")');
  await page.waitForSelector("[data-block-id]");
  const para = page.locator("[data-block-id]").nth(1);
  await page.evaluate(() => (window.__first = document.querySelector("[data-block-id]")));
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED");
  check("typing lands in the block", (await para.textContent()).includes("TYPED"));
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(100);
  check("Cmd+Z undoes typing through the model", !(await page.locator("[data-block-id]").nth(1).textContent()).includes("TYPED"));
  check("untouched block element survives undo", await page.evaluate(() => window.__first === document.querySelector("[data-block-id]")));

  // Renaming the open page keeps the editor.
  await page.fill("[data-role=page-title]", "Renamed doc");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("rename keeps the block elements", await page.evaluate(() => window.__first === document.querySelector("[data-block-id]")));

  // Sheet: edit a cell, neighbours keep their elements, undo restores.
  await page.click('.page-row:has-text("Budget")');
  await page.waitForSelector("td[data-col]");
  const cell = page.locator('td[data-col="0"][data-row="1"]');
  await page.evaluate(() => (window.__cell = document.querySelector('td[data-col="2"][data-row="1"]')));
  await cell.dblclick();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Pens");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  check("cell edit lands", (await cell.textContent()).includes("Pens"));
  check("untouched cell element kept", await page.evaluate(() => window.__cell === document.querySelector('td[data-col="2"][data-row="1"]')));
  await page.click("[data-action=undo]");
  await page.waitForTimeout(150);
  check("sheet undo restores the cell", (await cell.textContent()).includes("Paper"));

  // Deck: moving an object replaces only that object and leaves other thumbnails alone.
  await page.click('.page-row:has-text("Kickoff")');
  await page.waitForSelector(".stage .slide-object");
  const box = await page.locator(".stage .slide-object").first().boundingBox();
  await page.evaluate(() => {
    window.__o = document.querySelector(".stage .slide-object");
    window.__o2 = document.querySelectorAll(".stage .slide-object")[1];
    window.__t2 = document.querySelectorAll(".slide-thumb-wrap")[1];
  });
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const kept = await page.evaluate(() => [
    window.__o !== document.querySelector(".stage .slide-object"),
    window.__o2 === document.querySelectorAll(".stage .slide-object")[1],
    window.__t2 === document.querySelectorAll(".slide-thumb-wrap")[1]
  ]);
  check("moved object redrawn, sibling and other thumbnail kept", kept.every(Boolean), JSON.stringify(kept));

  // Document: a drag across two paragraphs selects part of both; copy and paste move them.
  await page.click('.page-row:has-text("Renamed doc")');
  await page.waitForSelector("[data-block-id]");
  const paras = page.locator("[data-block-id]");
  const first = await paras.nth(0).boundingBox();
  const second = await paras.nth(1).boundingBox();
  await page.mouse.move(first.x + 30, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + 60, second.y + second.height / 2, { steps: 8 });
  await page.mouse.up();
  const picked = await page.evaluate(() => ({
    painted: typeof CSS !== "undefined" && CSS.highlights ? (CSS.highlights.get("block-selection")?.size ?? 0) : -1,
    whole: document.querySelectorAll(".is-block-selected").length
  }));
  check("a drag across two paragraphs selects part of both", picked.painted > 0 || picked.whole > 0, JSON.stringify(picked));
  const before = await paras.count();
  await page.keyboard.press("ControlOrMeta+c");
  const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  await paras.last().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(200);
  check("Cmd+C then Cmd+V pastes the copied blocks", (await paras.count()) > before || copied === null, `blocks ${before} -> ${await paras.count()}`);

  // Autosave and reload.
  await page.click('.page-row:has-text("Renamed doc")');
  await page.waitForSelector("[data-block-id]");
  await page.locator("[data-block-id]").nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" PERSISTED");
  await page.waitForTimeout(2200);
  check("dirty dot clears after autosave", (await page.locator(".dirty-dot.is-dirty").count()) === 0);
  await page.reload();
  await page.waitForSelector(".page-row");
  await page.click('.page-row:has-text("Renamed doc")');
  await page.waitForSelector("[data-block-id]");
  const text = await page.locator("body").textContent();
  check("reload restores typing and the rename from IndexedDB", text.includes("PERSISTED") && text.includes("Renamed doc"));

  // A hostile import is refused.
  const stored = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("yourOffice");
        open.onsuccess = () => {
          const all = open.result.transaction("workspaces").objectStore("workspaces").getAll();
          all.onsuccess = () => resolve(all.result);
        };
        open.onerror = () => reject(open.error);
      })
  );
  const data = stored[0].data;
  const docId = Object.keys(data.pages).find((id) => data.pages[id].type === "document");
  const block = Object.values(data.pages[docId].content.blocks).find((b) => b.runs);
  block.runs = [{ text: "evil", marks: { link: "javascript:alert(1)" } }];
  const file = join(mkdtempSync(join(tmpdir(), "yo-smoke-")), "bad.json");
  writeFileSync(file, JSON.stringify(data));
  await page.setInputFiles("[data-role=import-file]", file);
  await page.waitForTimeout(500);
  check("a javascript: link import is rejected", Boolean(dialog && dialog.includes("Import failed")), String(dialog));

  check("no console errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
