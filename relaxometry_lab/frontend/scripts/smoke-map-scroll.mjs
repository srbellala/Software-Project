/**
 * Real-browser regression test for the T2/T1 map wheel-scroll fix: simulates
 * a trackpad-style burst of many tiny wheel events (as opposed to a mouse's
 * discrete notches) and checks that it doesn't fire one network request per
 * DOM event or overshoot the slice range.
 * Usage: node scripts/smoke-map-scroll.mjs http://127.0.0.1:PORT
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

await page.goto(`${baseUrl}/tool-next/`, { waitUntil: "networkidle0" });

await clickByText("a", "Load Sample Dataset");
await new Promise((r) => setTimeout(r, 2000));
await clickByText("button", "Continue to Preview");
await new Promise((r) => setTimeout(r, 1200));
await clickByText("button", "Continue to Fit");
await new Promise((r) => setTimeout(r, 300));
await clickByText("button", "Run fit");
await page.waitForFunction(() => document.body.textContent.includes("ROI Statistics"), { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));

const sliceMax = Number(await page.$eval("#map-slice-slider", (el) => el.max));
log("reached Output step with a real slice range", sliceMax > 0, `max=${sliceMax}`);

// Track every /result network request fired during the scroll burst.
let resultRequests = 0;
page.on("request", (req) => {
  if (req.url().includes("/api/fit/") && req.url().includes("/result")) resultRequests++;
});

const startSlice = Number(await page.$eval("#map-slice-slider", (el) => el.value));

// Simulate one trackpad swipe: ~40 tiny wheel events fired in quick succession,
// all in the same direction — this is exactly the pattern that used to cause
// dozens of overlapping requests and erratic slice jumps.
await page.evaluate(() => {
  const canvas = document.querySelector(".relative.overflow-hidden canvas") || document.querySelectorAll("canvas")[0];
  const rect = canvas.getBoundingClientRect();
  for (let i = 0; i < 40; i++) {
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 4, // typical single trackpad tick magnitude
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      })
    );
  }
});

// Slider should update immediately (optimistic UI), independent of the network.
await new Promise((r) => setTimeout(r, 20));
const sliderRightAfterBurst = Number(await page.$eval("#map-slice-slider", (el) => el.value));
log(
  "slider moved immediately without waiting on network (responsive UI)",
  sliderRightAfterBurst !== startSlice,
  `start=${startSlice} immediate=${sliderRightAfterBurst}`
);

// Give the debounce window (80ms) plus network time to settle.
await new Promise((r) => setTimeout(r, 800));

const finalSlice = Number(await page.$eval("#map-slice-slider", (el) => el.value));
const expectedDelta = Math.floor((40 * 4) / 60); // 40 events * deltaY 4, threshold 60 per slice
const expectedFinal = Math.max(0, Math.min(sliceMax, startSlice + expectedDelta));

log(
  "40-event trackpad burst produced a small, bounded number of network requests (not one-per-event)",
  resultRequests > 0 && resultRequests <= 3,
  `requests=${resultRequests}`
);
log(
  "final slice lands exactly where accumulated scroll distance predicts (no overshoot/loop)",
  finalSlice === expectedFinal,
  `final=${finalSlice} expected=${expectedFinal} (start=${startSlice})`
);
log("final slice stayed within valid bounds (no wraparound)", finalSlice >= 0 && finalSlice <= sliceMax, `final=${finalSlice} max=${sliceMax}`);

await browser.close();
process.exit(process.exitCode || 0);
