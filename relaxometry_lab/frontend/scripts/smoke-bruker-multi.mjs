/**
 * Real-browser smoke test for the multi-scan Bruker VFA selection feature:
 * checking several single-flip-angle scans in the Bruker Study Browser and
 * combining them into one flip-angle series.
 * Usage: node scripts/smoke-bruker-multi.mjs http://127.0.0.1:PORT /path/to/test_study.zip [FA1] [FA2] [FA3] [FA4]
 */
import puppeteer from "puppeteer-core";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] || "http://127.0.0.1:8129";
const zipPath = process.argv[3];
const faTags = process.argv.slice(4).length ? process.argv.slice(4) : ["FA6", "FA10", "FA14"];
if (!zipPath) {
  console.error("Usage: node scripts/smoke-bruker-multi.mjs <baseUrl> <zipPath> [FAtags...]");
  process.exit(1);
}

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

const fileInput = await page.$('input[type="file"]');
log("found scan file input", !!fileInput);
await fileInput.uploadFile(zipPath);

await page.waitForFunction(
  () => document.body.textContent.includes("Bruker Study Browser"),
  { timeout: 60000 }
);
log("Bruker Study Browser modal opened", true);

await page.waitForFunction(
  (tag) => document.body.textContent.includes(tag),
  { timeout: 60000 },
  faTags[0]
);
log("scan list populated with real scan titles", true);

const filteredT1 = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "T1");
  if (!btn) return false;
  btn.click();
  return true;
});
log("clicked T1 filter", filteredT1);

const checkedCount = await page.evaluate((tags) => {
  const rows = [...document.querySelectorAll("tbody tr")];
  let n = 0;
  const re = new RegExp(tags.join("|"));
  for (const row of rows) {
    if (re.test(row.textContent)) {
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.click();
        n++;
      }
    }
  }
  return n;
}, faTags);
log(`checked ${faTags.length} flip-angle scan rows`, checkedCount === faTags.length, `checked ${checkedCount}`);

const hintShowsN = await page.evaluate((n) => document.body.textContent.includes(`${n} scans checked`), faTags.length);
log(`hint shows '${faTags.length} scans checked for flip-angle series'`, hintShowsN);

const footerBtnText = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => /Load \d+ Scans as Flip-Angle Series/.test(x.textContent));
  return b ? b.textContent.trim() : null;
});
log("footer button switched to multi-select mode", !!footerBtnText, footerBtnText || "");

const clickedCombine = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => /Load \d+ Scans as Flip-Angle Series/.test(x.textContent));
  if (!b || b.disabled) return false;
  b.click();
  return true;
});
log("clicked 'Load N Scans as Flip-Angle Series'", clickedCombine);

await page.waitForFunction(
  () => !document.body.textContent.includes("Bruker Study Browser"),
  { timeout: 60000 }
);
log("modal closed after combining scans", true);

await new Promise((r) => setTimeout(r, 1500));

const errorShown = await page.evaluate(() => document.body.textContent.includes("Not Found") || document.body.textContent.includes("no flip angle"));
log("no error toast shown after combining", !errorShown);

const scanFilesShown = await page.evaluate((tag) => document.body.textContent.includes(tag), faTags[0]);
log("combined scan's file list shown in Load step", scanFilesShown);

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
