/**
 * Drives the demo harness in real Chromium against the real Web Audio API.
 * The node tests prove the transport logic; this proves the engine survives
 * contact with an actual AudioContext, which the fake cannot tell us.
 *
 * Run: node test/browser-smoke.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const path = join(ROOT, rel === "/" ? "demo/index.html" : rel);
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok" : "NOT OK"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Chromium always probes /favicon.ico; that 404 is browser noise, not the
    // app failing. The URL lives on the message location, not in its text.
    const url = m.location()?.url || "";
    if (url.endsWith("/favicon.ico")) return;
    errors.push(`${m.text()} (${url})`);
  });

  await page.goto(`http://127.0.0.1:${port}/demo/index.html`);
  await page.waitForLoadState("networkidle");

  check("page loads with no JS errors", errors.length === 0, errors.join("; "));

  // Build a real graph from synthesized buffers.
  await page.click("#tones");
  await page.waitForSelector(".strip");

  const stripCount = await page.locator(".strip").count();
  check("four channel strips rendered", stripCount === 4, `got ${stripCount}`);

  const duration = await page.textContent("#dur");
  check("duration reported from real buffers", duration === "1:00.00", `got ${duration}`);

  // Real playback against a real clock.
  await page.click("#play");
  await page.waitForTimeout(1200);
  const posA = await page.evaluate(() => document.getElementById("pos").textContent);
  const advanced = parseFloat(posA.split(":")[1]) > 0.5;
  check("position advances on the real audio clock", advanced, `pos=${posA}`);

  // Fader and mute reach the real GainNodes.
  await page.locator('.strip input[type=range]').first().fill("0.25");
  await page.waitForTimeout(100);
  const val = await page.locator(".strip .val").first().textContent();
  check("fader drives effective gain", val.trim() === "25%", `got ${val}`);

  await page.locator('.strip button[data-act="solo"]').nth(1).click();
  await page.waitForTimeout(100);
  const silenced = await page.locator(".strip.silent").count();
  check("solo silences the other three strips", silenced === 3, `${silenced} silent`);

  // Seek must rebuild sources without throwing InvalidStateError.
  const before = errors.length;
  // Drive it as a real drag: pointerdown first, or the rAF loop overwrites the
  // value we set before the change event is read.
  await page.locator("#scrub").dispatchEvent("pointerdown");
  await page.evaluate(() => (document.getElementById("scrub").value = 500));
  await page.locator("#scrub").dispatchEvent("change");
  await page.waitForTimeout(600);
  check("seek rebuilds sources without error", errors.length === before, errors.slice(before).join("; "));

  const posB = await page.evaluate(() => document.getElementById("pos").textContent);
  check("position reflects the seek", posB.startsWith("0:3"), `pos=${posB}`);

  await page.click("#stop");
  await page.waitForTimeout(150);
  const posC = await page.evaluate(() => document.getElementById("pos").textContent);
  check("stop rewinds to zero", posC === "0:00.00", `pos=${posC}`);

  check("no errors accumulated over the run", errors.length === 0, errors.join("; "));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
