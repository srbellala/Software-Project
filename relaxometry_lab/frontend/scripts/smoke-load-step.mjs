/**
 * Real-browser smoke test for the Load step of /tool-next, driving the
 * system's installed Chrome via puppeteer-core (no browser download).
 * Usage: node scripts/smoke-load-step.mjs http://127.0.0.1:PORT
 */
import puppeteer from "puppeteer-core";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] || "http://127.0.0.1:8129";

function log(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

await page.goto(`${baseUrl}/tool-next`, { waitUntil: "networkidle0" });

// 1. Initial mount
const title = await page.$eval("body", (b) => b.textContent.includes("Relaxometry Lab"));
log("app mounts with navbar brand", title);

const modalityLockedInitially = await page.$eval("#tool-t2", (el) => el.disabled);
log("modality toggle starts unlocked", modalityLockedInitially === false);

// 2. Click "Load Sample Dataset"
const clicked = await page.evaluate(() => {
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent.includes("Load Sample Dataset"));
  if (!link) return false;
  link.click();
  return true;
});
log("found and clicked 'Load Sample Dataset'", clicked);

// wait for the async session+demo+check round trip to settle
await new Promise((r) => setTimeout(r, 2500));

const scanFilesShown = await page.evaluate(() =>
  document.body.textContent.includes("demo_E0")
);
log("scan file list populated after demo load", scanFilesShown);

const segFilesShown = await page.evaluate(() => document.body.textContent.includes("demo_seg.nii.gz"));
log("segmentation file list populated after demo load", segFilesShown);

const modalityLockedAfter = await page.$eval("#tool-t2", (el) => el.disabled);
log("modality toggle locked after scan load", modalityLockedAfter === true);

const cardToggleLocked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent.trim() === "T2 (Multi-Echo)" || b.textContent.trim() === "T1 (VFA)"
  );
  return btns.length === 2 && btns.every((b) => b.disabled);
});
log("Load-step card modality toggle also locked (single source of truth)", cardToggleLocked);

const continueEnabled = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Continue to Preview"));
  return btn && !btn.disabled;
});
log("'Continue to Preview' enabled after successful demo load + check", continueEnabled);

// 3. Clear the scan and confirm everything unlocks/resets
const clearClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button[title="Clear uploaded scan"]')][0];
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
log("clicked scan clear (✕) button", clearClicked);

await new Promise((r) => setTimeout(r, 1500));

const modalityUnlockedAfterClear = await page.$eval("#tool-t2", (el) => el.disabled);
log("modality toggle unlocked again after clearing scan", modalityUnlockedAfterClear === false);

const scanListEmptyAfterClear = await page.evaluate(() => !document.body.textContent.includes("demo_E0"));
log("scan file list cleared", scanListEmptyAfterClear);

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
process.exit(process.exitCode || 0);
