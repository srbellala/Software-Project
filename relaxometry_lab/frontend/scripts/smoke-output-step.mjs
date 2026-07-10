/**
 * Real-browser smoke test for the Output step of /tool-next: runs a full
 * fit, then exercises ROI Summary, Voxel Explorer, and Comparison modes.
 * Usage: node scripts/smoke-output-step.mjs http://127.0.0.1:PORT
 */
import puppeteer from "puppeteer-core";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] || "http://127.0.0.1:8001";

function log(step, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, defaultViewport: { width: 1600, height: 1100 } });
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

function clickByText(tag, text) {
  return page.evaluate(
    (tag, text) => {
      const el = [...document.querySelectorAll(tag)].find((e) => e.textContent.includes(text) && !e.disabled);
      if (!el) return false;
      el.click();
      return true;
    },
    tag,
    text
  );
}

await page.goto(`${baseUrl}/tool-next`, { waitUntil: "networkidle0" });

await clickByText("a", "Load Sample Dataset");
await new Promise((r) => setTimeout(r, 2000));
await clickByText("button", "Continue to Preview");
await new Promise((r) => setTimeout(r, 1200));
await clickByText("button", "Continue to Fit");
await new Promise((r) => setTimeout(r, 300));
await clickByText("button", "Run fit");

// Wait for the fit to finish and auto-navigate to Output
await page.waitForFunction(() => document.body.textContent.includes("ROI Summary"), { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));

log("navigated to Output step (ROI Summary default)", await page.evaluate(() => document.body.textContent.includes("ROI Statistics")));

// ── ROI Summary mode ────────────────────────────────────────────────────
const roiChecks = await page.evaluate(() => {
  const mapCanvas = document.querySelector('canvas');
  const ctx = mapCanvas?.getContext("2d");
  let nonBlack = 0;
  if (ctx && mapCanvas.width > 0) {
    const data = ctx.getImageData(0, 0, mapCanvas.width, mapCanvas.height).data;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) nonBlack++;
  }
  const statRows = [...document.querySelectorAll("table")].some((t) => t.textContent.includes("Median") && t.textContent.includes("ms"));
  const plotlyDivs = document.querySelectorAll(".js-plotly-plot").length;
  return { canvasW: mapCanvas?.width, canvasH: mapCanvas?.height, nonBlack, statRows, plotlyDivs };
});
log("map canvas rendered with real pixel content", roiChecks.nonBlack > 100, JSON.stringify(roiChecks));
log("ROI stats table shows real values", roiChecks.statRows);
log("Plotly decay + histogram charts rendered", roiChecks.plotlyDivs >= 2, `found ${roiChecks.plotlyDivs}`);

// Slice scrubber changes the map
const sliceInput = await page.$("#map-slice-slider");
const sliceMax = await page.evaluate((el) => el.max, sliceInput);
log("slice slider has real max from volume shape", Number(sliceMax) > 0, `max=${sliceMax}`);

// ── Voxel Explorer mode ─────────────────────────────────────────────────
log("switched to Voxel Explorer mode", await clickByText("button", "Voxel Explorer"));
await new Promise((r) => setTimeout(r, 1200));
const voxelChecks = await page.evaluate(() => ({
  hasHint: document.body.textContent.includes("Click map to select voxel"),
  hasScatterTitle: document.body.textContent.includes("Distribution"),
  plotlyDivs: document.querySelectorAll(".js-plotly-plot").length,
}));
log("voxel-explorer map hint shown", voxelChecks.hasHint);
log("voxel-explorer Plotly charts rendered (signal/residual/scatter)", voxelChecks.plotlyDivs >= 3, `found ${voxelChecks.plotlyDivs}`);

// Click the map to select a voxel
const mapCanvasBox = await page.evaluate(() => {
  const c = document.querySelectorAll("canvas")[0];
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
});
await page.mouse.click(mapCanvasBox.x, mapCanvasBox.y);
await new Promise((r) => setTimeout(r, 800));
const selectedInfo = await page.evaluate(() => document.body.textContent.match(/Position[\s\S]{0,40}/)?.[0]);
log("clicking map selects a voxel and shows position", selectedInfo && !selectedInfo.includes("—)"), selectedInfo);

// ── Comparison mode ─────────────────────────────────────────────────────
log("switched to Comparison mode", await clickByText("button", "Comparison"));
await new Promise((r) => setTimeout(r, 500));
const emptyState = await page.evaluate(() => document.body.textContent.includes("No results saved yet"));
log("comparison starts empty", emptyState);

// Save current result
await page.evaluate(() => {
  const inp = document.querySelector('input[placeholder="Label for current result…"]');
  inp.value = "Smoke test scan";
  inp.dispatchEvent(new Event("input", { bubbles: true }));
});
log("clicked 'Save current result'", await clickByText("button", "Save current result"));
await new Promise((r) => setTimeout(r, 800));

const savedState = await page.evaluate(() => ({
  hasRow: document.querySelectorAll(".cmp-table tbody tr, table tbody tr").length,
  bodyText: document.body.textContent.includes("Smoke test scan") || document.body.textContent.includes("1 saved"),
}));
log("saved scan appears in comparison table", savedState.bodyText, JSON.stringify(savedState));

// Remove it again
const removeClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button[title="Remove"]')][0];
  if (!btn) return false;
  btn.click();
  return true;
});
log("clicked remove (×) on saved scan", removeClicked);
await new Promise((r) => setTimeout(r, 500));
const emptyAgain = await page.evaluate(() => document.body.textContent.includes("No results saved yet"));
log("comparison empty again after removing saved scan", emptyAgain);

// ── Downloads (only present in ROI Summary mode's sidebar) ──────────────
log("switched back to ROI Summary mode", await clickByText("button", "ROI Summary"));
await new Promise((r) => setTimeout(r, 500));
const downloadChecks = await page.evaluate(async () => {
  const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent.includes("↓"));
  return btns.map((b) => b.textContent.trim());
});
log("download buttons present (Map/Stats/Voxels/Report)", downloadChecks.length === 4, JSON.stringify(downloadChecks));

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 500));

await browser.close();
process.exit(process.exitCode || 0);
