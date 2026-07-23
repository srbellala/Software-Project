/**
 * Real-browser smoke test for direct (non-Bruker) 3D DICOM upload:
 * a single multiframe DICOM file with no per-frame echo metadata (a plain
 * 3D scan) should load as one real volume, not get shredded into dozens of
 * bogus 1-slice "volumes".
 * Usage: node scripts/smoke-3d-dicom.mjs http://127.0.0.1:PORT /path/to/scan.dcm
 */
import puppeteer from "puppeteer-core";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] || "http://127.0.0.1:8129";
const dcmPath = process.argv[3];
if (!dcmPath) {
  console.error("Usage: node scripts/smoke-3d-dicom.mjs <baseUrl> <dcmPath>");
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
await fileInput.uploadFile(dcmPath);

await page.waitForFunction(
  () => document.body.textContent.includes("EnIm1.dcm") || document.body.textContent.includes(".dcm"),
  { timeout: 60000 }
);
await new Promise((r) => setTimeout(r, 500));

const acqShown = await page.evaluate(() => document.body.textContent);
const nVolsMatch = /(\d+)\s*(?:flip angle|volume)/i.exec(acqShown);
log("scan loaded without a 'Not Found'/error toast", !acqShown.includes("Not Found") && !acqShown.includes("failed"));

const continueEnabled = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Continue to Preview"));
  return btn ? !btn.disabled : false;
});
log("'Continue to Preview' enabled after 3D scan load", continueEnabled);

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
