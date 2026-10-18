// Records the Paradox demo (PRD §19) with burned-in captions + an .srt track.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5180/";
const OUT = path.resolve(process.argv[2] ?? "./demo-out");
const FRAMES = path.join(OUT, "frames");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const W = 1440, APP_H = 900, BAND = 96, H = APP_H + BAND;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-first-run", "--no-default-browser-check", "--hide-scrollbars"],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1.5 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// Fresh, deterministic server state before the page loads.
for (const c of ["case001", "case002"]) {
  await fetch(new URL(`/api/cases/${c}/start`, APP), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ variant: "A", mode: "scripted", seed: 0, perturbations: [] }),
  });
}

await page.goto(APP, { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.body.innerText.includes("Detective Reasoning"));
await page.addStyleTag({ content: `
  #root > div { height: ${APP_H}px !important; min-height: 0 !important; }
  .fixed.bottom-4.right-4 { bottom: ${BAND + 16}px !important; }
  #demo-band { position: fixed; left: 0; right: 0; bottom: 0; height: ${BAND}px; z-index: 99999;
    background: #07090d; border-top: 1px solid #262c38; display: flex; align-items: center; justify-content: center;
    padding: 0 64px; font: 500 21px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; color: #eef1f6;
    text-align: center; }
  #demo-band span { transition: opacity .35s ease; }
  #demo-card { position: fixed; inset: 0; z-index: 100000; background: #07090d; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 18px; color: #eef1f6; transition: opacity .6s ease;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; text-align: center; }
  #demo-card h1 { font: 700 64px/1.1 Georgia, 'Times New Roman', serif; margin: 0; letter-spacing: -0.5px; }
  #demo-card p { margin: 0; font-size: 24px; color: #aab3c2; max-width: 980px; line-height: 1.45; }
  #demo-card small { font-size: 17px; color: #7c8697; letter-spacing: .4px; }
  .demo-focus { outline: 3px solid #f5c542 !important; outline-offset: 3px; border-radius: 6px; transition: outline-color .3s; }
`});
await page.evaluate(() => {
  const band = document.createElement("div");
  band.id = "demo-band";
  band.innerHTML = "<span></span>";
  document.body.appendChild(band);
});

// ---------------------------------------------------------------- recording
const cdp = await page.createCDPSession();
const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const file = path.join(FRAMES, `f${String(frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  frames.push({ file, t: metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId }); } catch {}
});

const captions = [];
let open = null;
const caption = async (text) => {
  const now = Date.now() / 1000;
  if (open) { open.end = now; captions.push(open); open = null; }
  await page.evaluate((t) => {
    const s = document.querySelector("#demo-band span");
    s.style.opacity = "0";
    setTimeout(() => { s.textContent = t; s.style.opacity = t ? "1" : "0"; }, 200);
  }, text);
  if (text) open = { text, start: now + 0.2 };
};
const card = async (title, sub, small, ms) => {
  await page.evaluate((title, sub, small) => {
    document.getElementById("demo-card")?.remove();
    const c = document.createElement("div");
    c.id = "demo-card";
    c.innerHTML = `<h1></h1><p></p><small></small>`;
    c.querySelector("h1").textContent = title;
    c.querySelector("p").textContent = sub;
    c.querySelector("small").textContent = small;
    document.body.appendChild(c);
  }, title, sub, small);
  await sleep(ms);
  await page.evaluate(() => { const c = document.getElementById("demo-card"); c.style.opacity = "0"; setTimeout(() => c.remove(), 650); });
  await sleep(700);
};
const clickButton = async (pred) => {
  const ok = await page.evaluate((src) => {
    const f = new Function("b", `return (${src})(b)`);
    const el = [...document.querySelectorAll("button")].find((b) => !b.disabled && f(b));
    if (el) { el.scrollIntoView({ block: "nearest" }); el.click(); }
    return !!el;
  }, pred.toString());
  if (!ok) throw new Error("button not found: " + pred);
};
const byText = (t) => new Function("b", `return b.textContent.trim().startsWith(${JSON.stringify(t)})`);
const focus = async (selFn, on = true) => page.evaluate((src, on) => {
  document.querySelectorAll(".demo-focus").forEach((e) => e.classList.remove("demo-focus"));
  if (!on) return;
  const el = new Function(`return (${src})()`)();
  if (el) { el.classList.add("demo-focus"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}, selFn.toString(), on);
const waitFor = (fn, ms = 60000) => page.waitForFunction(fn, { timeout: ms, polling: 200 });
const stepCount = () => page.evaluate(() => fetch("/api/cases/case001/state").then((r) => r.json()).then((s) => s.actions_taken));
const stepAndWait = async () => {
  const before = await stepCount();
  await clickButton((b) => b.textContent.trim() === "Step");
  await waitFor(`fetch("/api/cases/case001/state").then(r=>r.json()).then(s=>s.actions_taken>${before}||s.status!=="open")`);
};

await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 2160, maxHeight: 1494, everyNthFrame: 1 });
const t0 = Date.now() / 1000;

// Scene 0 — title
await card("Paradox", "The AI detective that knows what to ask next.",
  "Graph-native investigation on FalkorDB  ·  Bayesian beliefs  ·  information-gain planning", 4200);

// Scene 1 — open the mystery
await caption("Case 001: a prototype vanished from Lab A between 8 and 9 PM. Three suspects, three alibis.");
await sleep(4800);
await caption("Every person, statement, location and investigation lives in a FalkorDB graph. Undiscovered evidence is an empty placeholder.");
await sleep(5200);
await caption("The agent never sees the answer. Ground truth is sealed inside a separate simulator.");
await sleep(4200);

// Scene 2 — agent chooses an investigation
await caption("Step 1: the agent queries the graph and scores each eligible action by expected information gain ÷ cost.");
await stepAndWait();
await sleep(3800);
await caption("Top pick: the Lab A door log. No badge entries, so Ben (who has a passage override) rises from 33% to 63%.");
await sleep(5600);

// Scene 3 — evidence changes the graph, contradiction appears
await caption("Step 2: the main-entrance log. Ben's badge exited at 9:08 PM, but he said he left before 8:30.");
await stepAndWait();
await sleep(5200);
await caption("Walking times traversed in the graph make this a statement-vs-record contradiction. It is flagged, not taken as proof.");
await clickButton((b) => b.textContent.trim().startsWith("K-"));
await sleep(5600);

// Scene 4 — agent revises its plan
await caption("Step 3: the new evidence changes what is worth checking next. The agent inspects the maintenance-passage log.");
await stepAndWait();
await sleep(5200);
await caption("Ben's override code opened the passage door into Lab A at 8:41 PM. A second contradiction joins the graph.");
await sleep(4800);

// Scene 5 — conclusion
await caption("97.6% confidence and three independent evidence bundles meet the stopping rule, so the agent closes the case.");
await clickButton((b) => b.textContent.trim() === "Step");
await waitFor(() => document.body.innerText.toLowerCase().includes("simulator ground truth"));
await sleep(4500);
await caption("Only after closing is the simulator's ground truth unsealed. The conclusion matches it.");
await page.evaluate(() => {
  const m = [...document.querySelectorAll("div")].find((d) => d.innerText?.startsWith("CASE REPORT") && d.scrollHeight > d.clientHeight);
  const scroller = [...document.querySelectorAll("div")].filter((d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY !== "visible" && d.innerText.toLowerCase().includes("simulator ground truth"))[0];
  (scroller ?? m)?.scrollBy({ top: 420, behavior: "smooth" });
});
await sleep(4600);
await clickButton(byText("Close"));
await sleep(600);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => ["×", "✕", "✖"].includes(b.textContent.trim()) || /close/i.test(b.getAttribute("aria-label") ?? ""));
  btn?.click();
});
await sleep(400);

// Scene 6 — prove the system is dynamic
await caption("Is it scripted? Seal the maintenance-passage door, which deletes one CONNECTED_TO edge in the graph.");
await page.evaluate(() => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Seal the maintenance-passage door"));
  label.scrollIntoView({ block: "center", behavior: "smooth" });
  label.closest("li").classList.add("demo-focus");
  setTimeout(() => label.querySelector("input").click(), 900);
});
await sleep(3600);
await clickButton(byText("Restart with these settings"));
await focus(() => null, false);
await sleep(2200);
await caption("Passage evidence is now outside the crime scene's reach, so those actions become ineligible.");
await page.evaluate(() => {
  const el = [...document.querySelectorAll("li, button, div")].filter((d) => d.textContent.trim().startsWith("Inspect technician maintenance logs") && d.textContent.length < 400).pop();
  const box = el?.closest("li") ?? el;
  if (box) { box.scrollIntoView({ block: "center", behavior: "smooth" }); box.classList.add("demo-focus"); }
});
await sleep(4600);
await focus(() => null, false);
await caption("Same evidence model, new graph: the agent plans a different third step and still reaches a supported conclusion.");
await clickButton(byText("Start investigation"));
await waitFor(() => document.body.innerText.toLowerCase().includes("simulator ground truth"));
await sleep(5200);
await clickButton(byText("Close"));
await sleep(500);

// Scene 7 — honest uncertainty (case 002)
await caption("Case 002: four suspects. Seal the reading-room door and the evidence that could corroborate the leader is cut off.");
await page.select("header select", "case002");
await waitFor(() => document.body.innerText.includes("Midnight Manuscript"));
await sleep(1500);
await page.evaluate(() => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Seal the reading-room door"));
  label.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => label.querySelector("input").click(), 700);
});
await sleep(2200);
await clickButton(byText("Restart with these settings"));
await sleep(1800);
await caption("The agent investigates on its own: archive door log, badge audit, then the only witness it can still reach.");
await clickButton(byText("Start investigation"));
await waitFor(() => document.body.innerText.toLowerCase().includes("simulator ground truth"));
await sleep(800);
await caption("Paradox reaches 97% on Esme but reports the case as inconclusive: no reachable evidence can independently confirm it.");
await sleep(6400);
await caption("");
await clickButton(byText("Close"));
await sleep(400);

// End card
await card("Paradox", "Observe → query the graph → evaluate hypotheses → choose → execute → update → repeat.",
  "Two fictional cases  ·  49 tests  ·  information gain beats fixed-order and random baselines on cost and accuracy", 4800);

await cdp.send("Page.stopScreencast");
if (open) { open.end = Date.now() / 1000; captions.push(open); }
await sleep(300);
await browser.close();

// ---------------------------------------------------------------- outputs
const first = frames[0].t;
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const dur = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0.5;
  lines.push(`file '${frames[i].file}'`, `duration ${Math.max(dur, 0.001).toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);
fs.writeFileSync(path.join(OUT, "frames.txt"), lines.join("\n"));

const ts = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
const srt = captions.map((c, i) => `${i + 1}\n${ts(c.start - first)} --> ${ts(c.end - first)}\n${c.text}\n`).join("\n");
fs.writeFileSync(path.join(OUT, "captions.srt"), srt);
console.log(JSON.stringify({ frames: frames.length, seconds: frames.at(-1).t - first, captions: captions.length, startOffset: t0 - first, errors }));
