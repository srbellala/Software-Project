/**
 * Real-browser smoke test for the new /next landing page: checks it renders
 * the right React tree (not the wizard), key content sections are present,
 * "Open Tool" navigates to /tool, and "Try with Sample Data" actually
 * auto-loads demo data in the wizard (fixing what was dead code in the
 * original vanilla app).
 * Usage: node scripts/smoke-landing.mjs http://127.0.0.1:PORT
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

await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });

const content = await page.evaluate(() => document.body.textContent);
log("renders landing page (not the wizard)", content.includes("Relaxometry Lab") && !content.includes("Scan Files"));
log("hero section present", content.includes("Open Source") && content.includes("relaxometry fitting"));
log("tool cards present (T2/T1/T2*)", content.includes("T₂ Relaxometry") && content.includes("T₁ Relaxometry") && content.includes("Coming Soon"));
log("how-it-works steps present", content.includes("Load Data") && content.includes("Preview") && content.includes("Export"));
log("data format cards present", content.includes("DICOM") && content.includes("NIfTI") && content.includes("Bruker Study ZIP"));
log("resources section present", content.includes("Sample Dataset") && content.includes("GitHub"));

// "Open Tool" navigates to the wizard
await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => x.textContent.trim() === "Open Tool");
  a.click();
});
await new Promise((r) => setTimeout(r, 600));
log("'Open Tool' navigates to /tool wizard", (await page.url()).endsWith("/tool"));
log("wizard renders after navigating from landing", (await page.evaluate(() => document.body.textContent)).includes("Scan Files"));

// Back to landing, test "Try with Sample Data" auto-loads demo
await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => x.textContent.trim() === "Try with Sample Data");
  a.click();
});
await new Promise((r) => setTimeout(r, 2500));
const autoLoaded = await page.evaluate(() => document.body.textContent.includes("demo_E0"));
log("'Try with Sample Data' auto-loads demo data in the wizard", autoLoaded);

log("no console/page errors during the whole flow", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
process.exit(process.exitCode || 0);
