/**
 * Real-browser smoke test for the Preview step (ortho viewer) of /tool-next.
 * Usage: node scripts/smoke-preview-step.mjs http://127.0.0.1:PORT
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

await page.goto(`${baseUrl}/tool-next`, { waitUntil: "networkidle0" });

// Load demo data
await page.evaluate(() => {
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent.includes("Load Sample Dataset"));
  link.click();
});
await new Promise((r) => setTimeout(r, 2000));

const continueEnabled = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Continue to Preview"));
  return btn && !btn.disabled;
});
log("'Continue to Preview' enabled after demo load", continueEnabled);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Continue to Preview"));
  btn.click();
});
await new Promise((r) => setTimeout(r, 2000));

const onPreviewStep = await page.evaluate(() => document.body.textContent.includes("Multi-Viewer Preview"));
log("navigated to Preview step", onPreviewStep);

// Wait for volume load to finish
await page.waitForFunction(() => !document.body.textContent.includes("Loading volume"), { timeout: 8000 }).catch(() => {});

const canvasCount = await page.evaluate(() => document.querySelectorAll("canvas").length);
log("3 ortho canvases rendered", canvasCount === 3, `found ${canvasCount}`);

// Check canvases actually have non-blank pixel content (not just black/empty)
const pixelStats = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll("canvas")];
  return canvases.map((c) => {
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonZero = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) nonZero++;
    }
    return { w: c.width, h: c.height, nonZeroPx: nonZero };
  });
});
pixelStats.forEach((s, i) => {
  log(`canvas ${i} has real pixel content`, s.nonZeroPx > 100, `${s.w}x${s.h}, ${s.nonZeroPx} non-black px`);
});

// Slice sliders should have max > 0 (set from real volume shape)
const sliceMaxes = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input[type="range"]')];
  // first 3 range inputs after the overlay/volume ones are the slice sliders (order: alpha, vol, then 3x slice)
  return inputs.map((i) => ({ max: i.max, value: i.value }));
});
log("at least one slider has a real max > 0", sliceMaxes.some((s) => Number(s.max) > 0), JSON.stringify(sliceMaxes));

// Clicking the axial (1st) canvas sets X/Y (not Z) per OrthoEngine._onClick —
// check the "x:"/"y:" labels change, not "z:" (which axial clicks don't touch).
const beforeXY = await page.evaluate(() => [...document.body.textContent.matchAll(/[xy]: \d+/g)].map((m) => m[0]));
const canvasBox = await page.evaluate(() => {
  const c = document.querySelectorAll("canvas")[0];
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width * 0.2, y: r.top + r.height * 0.2 };
});
await page.mouse.click(canvasBox.x, canvasBox.y);
await new Promise((r) => setTimeout(r, 200));
const afterXY = await page.evaluate(() => [...document.body.textContent.matchAll(/[xy]: \d+/g)].map((m) => m[0]));
log(
  "clicking axial canvas updates x/y crosshair position labels",
  JSON.stringify(beforeXY) !== JSON.stringify(afterXY),
  `${beforeXY.join(",")} -> ${afterXY.join(",")}`
);

// Toggle segmentation overlay checkbox
const overlayToggled = await page.evaluate(() => {
  const chk = document.getElementById("seg-overlay-chk");
  if (!chk) return false;
  chk.click();
  return chk.checked;
});
log("segmentation overlay checkbox toggles", overlayToggled === true);

// Back button returns to Load step
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("← Back"));
  btn.click();
});
await new Promise((r) => setTimeout(r, 300));
const backOnLoad = await page.evaluate(() => document.body.textContent.includes("Scan Files"));
log("'← Back' returns to Load step", backOnLoad);

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
process.exit(process.exitCode || 0);
