/**
 * Real-browser smoke test for the Fit step of /tool-next: loads demo data,
 * navigates Load -> Preview -> Fit, checks the param table + derived values,
 * runs a real fit against the backend, and watches the SSE progress bar
 * through to completion (auto-advancing to Output).
 * Usage: node scripts/smoke-fit-step.mjs http://127.0.0.1:PORT
 */
import puppeteer from "puppeteer-core";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] || "http://127.0.0.1:8001";

function log(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

function clickByText(tag, text) {
  return page.evaluate(
    (tag, text) => {
      const el = [...document.querySelectorAll(tag)].find((e) => e.textContent.includes(text));
      if (!el || el.disabled) return false;
      el.click();
      return true;
    },
    tag,
    text
  );
}

await page.goto(`${baseUrl}/tool-next`, { waitUntil: "networkidle0" });

log("clicked 'Load Sample Dataset'", await clickByText("a", "Load Sample Dataset"));
await new Promise((r) => setTimeout(r, 2000));

log("clicked 'Continue to Preview'", await clickByText("button", "Continue to Preview"));
await new Promise((r) => setTimeout(r, 1500));

log("clicked 'Continue to Fit'", await clickByText("button", "Continue to Fit"));
await new Promise((r) => setTimeout(r, 300));

const onFitStep = await page.evaluate(() => document.body.textContent.includes("Configure the Fit"));
log("navigated to Fit step", onFitStep);

const modelInfo = await page.evaluate(() => ({
  hasModelTag: document.body.textContent.includes("Model: T2 Mono-Exponential"),
  hasEqn: document.body.textContent.includes("S(TE) = C + S"),
  hasR2Row: document.body.textContent.includes("R2"),
}));
log("shows T2 model tag + equation", modelInfo.hasModelTag && modelInfo.hasEqn);
log("param table includes derived R2 row", modelInfo.hasR2Row);

// Check the derived R2 value reacts to editing T2 init
const numberInputs = await page.$$('input[type="number"]');
log("param table has number inputs", numberInputs.length > 0, `found ${numberInputs.length}`);

// Derived R2 init cell = first `.font-mono` cell in the table (fmt() renders
// "50" not "50.0" for whole numbers — verified this matches the ported
// vanilla formula, not a bug).
const r2Before = await page.evaluate(() => document.querySelector("td.font-mono")?.textContent);
// Row order: S0 ratio (init,lo,hi = idx 0,1,2), T2 (init,lo,hi = idx 3,4,5) — T2 init is idx 3.
// Set the value via the native setter + "input" event (what React's onChange
// listens for) rather than click+type, which doesn't reliably select-all in
// a number input under headless Chrome.
await page.evaluate((idx) => {
  const el = document.querySelectorAll('input[type="number"]')[idx];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, "40");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, 3);
await new Promise((r) => setTimeout(r, 200));
const r2After = await page.evaluate(() => document.querySelector("td.font-mono")?.textContent);
log(
  "editing T2 init updates derived R2 value",
  r2Before === "50" && r2After === "25",
  `R2 init: ${r2Before} -> ${r2After}`
);

// Run the fit for real against the backend. The fit engine is now a vectorized
// whole-volume solve (see api/fit_engine.py) rather than a per-voxel loop, so
// for small volumes like the demo dataset it can complete in well under one
// polling interval — never showing an intermediate "Fitting… X / Y voxels"
// message at all. That's the speedup working, not a hang, so this only fails
// if the fit neither shows progress nor ever leaves the Fit step.
log("clicked 'Run fit'", await clickByText("button", "Run fit"));

let sawProgress = false;
let leftFitStep = false;
for (let i = 0; i < 40; i++) {
  const text = await page.evaluate(() => document.body.textContent);
  if (/Fitting… \d+ \/ \d+ voxels/.test(text)) sawProgress = true;
  if (text.includes("Configure the Fit") === false) {
    leftFitStep = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
log("fit ran to completion (progress shown or fast enough to skip straight through)", sawProgress || leftFitStep);

// Wait for auto-navigation to the real Output step after completion
await page.waitForFunction(() => document.body.textContent.includes("ROI Summary"), { timeout: 10000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));
const reachedOutput = await page.evaluate(() => document.body.textContent.includes("ROI Statistics"));
log("auto-navigated to Output step after fit completed", reachedOutput);

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
process.exit(process.exitCode || 0);
