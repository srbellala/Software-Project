/**
 * Real-browser smoke test for the T1 (VFA) fit path end-to-end, using the
 * linearized DESPOT1 fitting engine.
 * Usage: node scripts/smoke-t1-fit-step.mjs http://127.0.0.1:PORT
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

const switchedT1 = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "T1 (VFA)");
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
log("switched modality to T1 (VFA)", switchedT1);

const clickedDemo = await page.evaluate(() => {
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent.includes("Load Sample Dataset"));
  if (!link) return false;
  link.click();
  return true;
});
log("clicked 'Load Sample Dataset'", clickedDemo);
await new Promise((r) => setTimeout(r, 2000));

const scanFilesShown = await page.evaluate(() => document.body.textContent.includes("fa_03deg_demo"));
log("T1 demo scan files populated (flip-angle series)", scanFilesShown);

const wentToPreview = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Continue to Preview"));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
log("clicked 'Continue to Preview'", wentToPreview);
await new Promise((r) => setTimeout(r, 800));

const wentToFit = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Continue to Fit"));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
log("clicked 'Continue to Fit'", wentToFit);
await new Promise((r) => setTimeout(r, 800));

const showsT1Model = await page.evaluate(() => document.body.textContent.includes("T1"));
log("Fit step shows T1 model tag", showsT1Model);

const clickedRun = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Run fit"));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
log("clicked 'Run fit'", clickedRun);

await page.waitForFunction(
  () => document.body.textContent.includes("Output") || document.body.textContent.includes("ROI"),
  { timeout: 30000 }
).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

const statsShown = await page.evaluate(() => {
  const text = document.body.textContent;
  return /median/i.test(text) || /Median/.test(text);
});
log("T1 fit completed and stats rendered on Output step", statsShown);

const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return null;
  const ctx = c.getContext("2d");
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) nonBlack++;
  return { nonBlack };
});
log("T1 map canvas has real pixel content", canvasInfo && canvasInfo.nonBlack > 100, JSON.stringify(canvasInfo));

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
