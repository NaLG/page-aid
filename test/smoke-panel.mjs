#!/usr/bin/env node
// End-to-end smoke test with visual confirmation, no live LLM needed.
//
// Launches REAL Firefox (web-ext) with an instrumented copy of the extension:
// the real background.js and panel.js run unmodified; a test-only background
// script (bg-test.js) stands in for the toolbar click, because the activeTab
// user gesture is the one thing a harness cannot synthesize — the test build
// pre-grants <all_urls> and calls the same insertCSS/executeScript pair as
// background.inject(). A localhost server plays three parts: static test
// article, mock OpenAI SSE endpoint, and report/screenshot sink.
//
// Verified end to end:
//   - panel injects and renders its empty state (hint + summarize chip)
//   - page text is extracted from <main> (sentinel reaches the LLM request,
//     nav junk outside <main> does not)
//   - the ask flow streams through the real engine and renders markdown
//     (bold, code, list) with the question echoed above the answer
//   - repeat injection toggles hide/show (window.__pageAid guard)
//   - PNG screenshots land in test/artifacts/ for human/model eyeballs
//
// Usage: node test/smoke-panel.mjs        (exit 0 = every assertion passed)
//        PAGEAID_DEBUG=1 …                (web-ext/Firefox output + pings)

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIREFOX = process.env.PAGEAID_FIREFOX || "/Applications/Firefox.app/Contents/MacOS/firefox";
const DEBUG = process.env.PAGEAID_DEBUG === "1";
const ARTIFACTS = join(ROOT, "test", "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

const QUESTION = "What is the secret word in this article?";
const SENTINEL = "XYLOPHONE";
const NAVJUNK = "NAVJUNKTOKEN";
const ANSWER_MD =
  "**Answer:** The secret word is `" + SENTINEL + "`.\n\n" +
  "Key points from the article:\n" +
  "- The word appears in the second paragraph\n" +
  "- This bullet verifies list rendering\n\n" +
  "That is everything the page says about it.";

// ---- localhost: test page + mock LLM + report sink --------------------------

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page Aid Smoke Test Article</title></head>
<body>
  <nav>${NAVJUNK} home · products · pricing · contact</nav>
  <main>
    <article>
      <h1>The Curious Case of the Hidden Word</h1>
      <p>This article exists so an automated harness can prove that a browser
      extension reads real page content. It contains several paragraphs of
      ordinary prose, long enough to pass the extractor's minimum-length check
      for the main landmark, and one deliberately unusual fact planted in the
      middle of otherwise unremarkable text.</p>
      <p>Here is the planted fact: the secret word is ${SENTINEL}. Remember it,
      because the harness will ask about it and expects the answer to come back
      through the full streaming pipeline rather than from anything hard-coded
      in the page or the extension.</p>
      <p>The remaining text is filler to make the article realistically sized.
      Extraction should prefer this main element and skip the navigation bar
      above, whose junk token must never appear in the request the extension
      sends to the model endpoint. If it does, landmark preference is broken
      and the assertion for it will fail loudly.</p>
    </article>
  </main>
</body></html>`;

let llmRequest = null; // parsed body of the /chat/completions call
let llmAuthHeader = null;
const shots = {}; // name -> saved path
let resolveFinal;
const finalReport = new Promise((r) => (resolveFinal = r));

const cors = () => ({ "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });

function collect(req, cb) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => cb(body));
}

function streamSSE(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors() });
  const slices = [];
  for (let i = 0; i < ANSWER_MD.length; i += 24) slices.push(ANSWER_MD.slice(i, i + 24));
  let i = 0;
  const tick = setInterval(() => {
    if (i < slices.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: slices[i++] } }] })}\n\n`);
    } else {
      clearInterval(tick);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, 40); // chunked, so the throttled live-render path actually runs
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors()); res.end(); return; }
  if (req.method === "GET" && req.url.startsWith("/test.html")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    llmAuthHeader = req.headers.authorization || null;
    collect(req, (body) => {
      try { llmRequest = JSON.parse(body); } catch { llmRequest = { parseError: body.slice(0, 200) }; }
      streamSSE(res);
    });
    return;
  }
  if (req.method === "POST" && req.url === "/report") {
    collect(req, (body) => {
      res.writeHead(204, cors());
      res.end();
      let msg;
      try { msg = JSON.parse(body); } catch { return; }
      if (msg.shot) {
        const file = join(ARTIFACTS, `${msg.name}.png`);
        writeFileSync(file, Buffer.from(msg.shot.split(",")[1], "base64"));
        shots[msg.name] = file;
        if (DEBUG) console.log(`  [shot] ${file}`);
      } else if (msg.final) {
        resolveFinal(msg);
      } else if (DEBUG) {
        console.log(`  [ping] ${body.slice(0, 200)}`);
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
const PORT = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

// ---- build the instrumented extension copy ----------------------------------

const extDir = mkdtempSync(join(tmpdir(), "pageaid-smoke-"));
cpSync(join(ROOT, "src"), extDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, "src", "manifest.json"), "utf8"));
manifest.name = "Page Aid smoke test";
manifest.browser_specific_settings.gecko.id = "page-aid-smoke@nalg.dev";
// The real build's activeTab gesture can't be synthesized, so the test build
// pre-grants host access; everything else about the flow is the shipped code.
manifest.permissions = ["storage", "tabs", "<all_urls>"];
manifest.background = { scripts: ["background/background.js", "bg-test.js"], persistent: true };
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// In-page driver, executed in the test tab: types the question, clicks Ask,
// polls until the streamed answer lands (input re-enabled = stream finished).
const driveSrc = `(async () => {
  const input = document.querySelector('#pageaid-panel .pageaid-ask input');
  const btn = document.querySelector('#pageaid-panel .pageaid-ask button');
  if (!input || !btn) return { ok: false, error: 'panel controls not found' };
  const emptyState = {
    hint: !!document.querySelector('#pageaid-panel .pageaid-hint'),
    chip: !!document.querySelector('#pageaid-panel .pageaid-chip'),
  };
  input.value = ${JSON.stringify(QUESTION)};
  btn.click();
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const a = document.querySelector('#pageaid-panel .pageaid-qa-a');
    if (a && a.classList.contains('pageaid-error')) return { ok: false, error: a.textContent, emptyState };
    if (a && a.textContent.indexOf(${JSON.stringify(SENTINEL)}) !== -1 && !input.disabled) {
      return {
        ok: true,
        emptyState,
        answerText: a.textContent.slice(0, 400),
        hasStrong: !!a.querySelector('strong'),
        listItems: a.querySelectorAll('ul li').length,
        hasCode: !!a.querySelector('code'),
        emptyStateGone: !document.querySelector('#pageaid-panel .pageaid-hint'),
        qShown: (document.querySelector('#pageaid-panel .pageaid-qa-q') || {}).textContent || null,
      };
    }
  }
  const a = document.querySelector('#pageaid-panel .pageaid-qa-a');
  return { ok: false, error: 'timeout waiting for answer', partial: a ? a.textContent.slice(0, 200) : null, emptyState };
})()`;

const checkSrc = `(() => {
  const p = document.getElementById('pageaid-panel');
  return { present: !!p, hidden: !!p && p.classList.contains('pageaid-hidden') };
})()`;

// Drags the panel by its bar with synthetic pointer events, then collapses and
// re-expands via the title, measuring that the panel moves and stays put.
const dragSrc = `(async () => {
  const panel = document.getElementById('pageaid-panel');
  const bar = panel.querySelector('.pageaid-bar');
  const title = panel.querySelector('.pageaid-title');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r0 = panel.getBoundingClientRect();
  const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y });
  const bx = r0.left + 60, by = r0.top + 18;
  bar.dispatchEvent(new PointerEvent('pointerdown', opts(bx, by)));
  bar.dispatchEvent(new PointerEvent('pointermove', opts(bx - 140, by + 90)));
  bar.dispatchEvent(new PointerEvent('pointerup', opts(bx - 140, by + 90)));
  await sleep(50);
  const r1 = panel.getBoundingClientRect();
  // Collapse via a REAL pointer press (down+up, no synthetic .click()): the
  // drag handler preventDefaults pointerdown, which suppresses native clicks,
  // so the toggle must work from the pointer path itself. A .click()-based
  // test passed while actual mouse clicks did nothing — never again.
  const pclick = () => {
    const tr = title.getBoundingClientRect();
    const x = tr.left + 8, y = tr.top + tr.height / 2;
    title.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
    title.dispatchEvent(new PointerEvent('pointerup', opts(x, y)));
  };
  pclick(); // collapse (must NOT fire from the drag above, only from this)
  await sleep(80);
  const collapsed = panel.classList.contains('pageaid-collapsed');
  const rc = panel.getBoundingClientRect();
  pclick(); // expand again
  await sleep(80);
  // West-edge resize: pull the left edge 100px left; width grows, right edge
  // stays planted (the gesture native resize:both could never do).
  const w0 = panel.getBoundingClientRect();
  const wz = panel.querySelector('.pageaid-rz-w');
  const wr = wz.getBoundingClientRect();
  const wx = wr.left + 3, wy = wr.top + wr.height / 2;
  wz.dispatchEvent(new PointerEvent('pointerdown', opts(wx, wy)));
  wz.dispatchEvent(new PointerEvent('pointermove', opts(wx - 100, wy)));
  wz.dispatchEvent(new PointerEvent('pointerup', opts(wx - 100, wy)));
  await sleep(50);
  const w1 = panel.getBoundingClientRect();
  // Hit-test the top strip: center must be the draggable bar, corners the
  // resize zones (dispatching events on elements can't prove stacking; this can).
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'none';
    const cls = String(el.className || '');
    if (cls.indexOf('pageaid-rz') !== -1) return cls.replace('pageaid-rz ', '');
    return el.closest && el.closest('.pageaid-bar') ? 'bar' : cls;
  };
  const rp = panel.getBoundingClientRect();
  // +6 keeps the corner probes inside the 12px border-radius clip.
  return {
    topCenter: hit(rp.left + rp.width / 2, rp.top + 3),
    topLeft: hit(rp.left + 6, rp.top + 6),
    topRight: hit(rp.right - 6, rp.top + 6),
    handles: panel.querySelectorAll('.pageaid-rz').length,
    anchored: !!panel.style.left,
    dx: Math.round(r1.left - r0.left),
    dy: Math.round(r1.top - r0.top),
    collapsed,
    collapsedStaysPut: Math.abs(rc.left - r1.left) < 6 && Math.abs(rc.top - r1.top) < 6,
    collapsedShrank: rc.height < r1.height - 40,
    expandedAgain: !panel.classList.contains('pageaid-collapsed'),
    resizeDw: Math.round(w1.width - w0.width),
    resizeDl: Math.round(w1.left - w0.left),
    resizeRightPlanted: Math.abs(w1.right - w0.right) < 3,
  };
})()`;

// Runs after collapseStyle is switched to "dock": title press should send the
// pill to the bottom-right corner; expanding should restore the old position.
const dockSrc = `(async () => {
  const panel = document.getElementById('pageaid-panel');
  const title = panel.querySelector('.pageaid-title');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: y });
  const pclick = () => {
    const tr = title.getBoundingClientRect();
    const x = tr.left + 8, y = tr.top + tr.height / 2;
    title.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
    title.dispatchEvent(new PointerEvent('pointerup', opts(x, y)));
  };
  const before = panel.getBoundingClientRect();
  pclick();
  await sleep(80);
  const collapsed = panel.classList.contains('pageaid-collapsed');
  const rd = panel.getBoundingClientRect();
  pclick();
  await sleep(80);
  const after = panel.getBoundingClientRect();
  return {
    collapsed,
    dockBR: Math.abs(window.innerWidth - rd.right - 16) <= 4 && Math.abs(window.innerHeight - rd.bottom - 16) <= 4,
    restored: Math.abs(after.left - before.left) < 6 && Math.abs(after.top - before.top) < 6,
    expanded: !panel.classList.contains('pageaid-collapsed'),
  };
})()`;

writeFileSync(
  join(extDir, "bg-test.js"),
  `// TEST ONLY — not part of the shipped extension (see test/smoke-panel.mjs).
const BASE = "http://127.0.0.1:${PORT}";
const report = (msg) => fetch(BASE + "/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRIVE = ${JSON.stringify(driveSrc)};
const CHECK = ${JSON.stringify(checkSrc)};
const DRAG = ${JSON.stringify(dragSrc)};
const DOCK = ${JSON.stringify(dockSrc)};
async function shot(tab, name) {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await fetch(BASE + "/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shot: dataUrl, name }) });
  } catch (e) { report({ ping: true, m: "screenshot failed", err: String(e) }); }
}
(async () => {
  try {
    await browser.storage.local.set({ provider: "openai", baseUrl: BASE + "/v1", model: "mock-model", apiKey: "test-key" });
    report({ ping: true, m: "config set" });
    let tab = null;
    for (let i = 0; i < 120 && !tab; i++) {
      const tabs = await browser.tabs.query({});
      tab = tabs.find((t) => (t.url || "").startsWith(BASE + "/test.html") && t.status === "complete") || null;
      if (!tab) await sleep(500);
    }
    if (!tab) { report({ final: true, ok: false, error: "test tab never loaded" }); return; }
    await sleep(500);
    // Same pair background.inject() runs on toolbar click.
    await browser.tabs.insertCSS(tab.id, { file: "/content/panel.css" });
    await browser.tabs.executeScript(tab.id, { file: "/content/panel.js" });
    await sleep(400);
    await shot(tab, "1-panel-open");
    const [drive] = await browser.tabs.executeScript(tab.id, { code: DRIVE });
    await sleep(200);
    await shot(tab, "2-answer");
    // Repeat injection = toggle: second exec hides, third shows again.
    await browser.tabs.executeScript(tab.id, { file: "/content/panel.js" });
    const [afterHide] = await browser.tabs.executeScript(tab.id, { code: CHECK });
    await browser.tabs.executeScript(tab.id, { file: "/content/panel.js" });
    const [afterShow] = await browser.tabs.executeScript(tab.id, { code: CHECK });
    const [drag] = await browser.tabs.executeScript(tab.id, { code: DRAG });
    await browser.storage.local.set({ collapseStyle: "dock" });
    await sleep(300); // let storage.onChanged reach the content script
    const [dock] = await browser.tabs.executeScript(tab.id, { code: DOCK });
    await sleep(200);
    await shot(tab, "3-dragged");
    report({ final: true, ok: true, drive, afterHide, afterShow, drag, dock });
  } catch (e) {
    report({ final: true, ok: false, error: String(e) });
  }
})();`
);

// ---- run Firefox -------------------------------------------------------------

const profileDir = mkdtempSync(join(tmpdir(), "pageaid-ff-"));
const child = spawn(
  join(ROOT, "node_modules", ".bin", "web-ext"),
  [
    "run", "--source-dir", extDir, "--no-reload", "--no-input",
    "--start-url", `http://127.0.0.1:${PORT}/test.html`,
    "--firefox", FIREFOX, "--firefox-profile", profileDir, "--profile-create-if-missing",
  ],
  { stdio: ["ignore", DEBUG ? "inherit" : "ignore", DEBUG ? "inherit" : "ignore"] }
);
child.on("error", (e) => {
  console.error("web-ext spawn error:", e.message);
  process.exit(1);
});

console.log(`Smoke test: real Firefox + mock LLM on 127.0.0.1:${PORT} …`);
const TIMEOUT_MS = 90000;
const result = await Promise.race([
  finalReport,
  new Promise((r) => setTimeout(() => r({ final: true, ok: false, error: `timeout after ${TIMEOUT_MS / 1000}s` }), TIMEOUT_MS)),
]);

try { child.kill("SIGTERM"); } catch {}
setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
server.close();

// ---- assertions ---------------------------------------------------------------

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
}

const d = result.drive || {};
check("harness completed without background error", result.ok, result.error);
check("panel injected with ask controls", d.ok || d.emptyState, d.error);
check("empty state showed hint + summarize chip", d.emptyState?.hint && d.emptyState?.chip, d.emptyState);
check("streamed answer contains sentinel", (d.answerText || "").includes(SENTINEL), d.answerText || d.error);
check("markdown rendered: bold", d.hasStrong, d.answerText);
check("markdown rendered: inline code", d.hasCode);
check("markdown rendered: list items", (d.listItems || 0) >= 2, d.listItems);
check("question echoed above answer", (d.qShown || "").includes(QUESTION), d.qShown);
check("empty state cleared after ask", d.emptyStateGone);

const msgs = llmRequest?.messages || [];
const firstUser = msgs.find((m) => m.role === "user")?.content || "";
const last = msgs[msgs.length - 1]?.content || "";
check("engine called the mock endpoint", !!llmRequest);
check("request: system prompt present", msgs[0]?.role === "system" && /web page/i.test(msgs[0]?.content || ""), msgs[0]);
check("request: page title + sentinel extracted from <main>", firstUser.includes("Page Aid Smoke Test Article") && firstUser.includes(SENTINEL));
check("request: nav junk excluded (landmark preference)", !firstUser.includes(NAVJUNK));
check("request: question is the last message", last === QUESTION, last);
check("request: streaming on, model + key passed through", llmRequest?.stream === true && llmRequest?.model === "mock-model" && llmAuthHeader === "Bearer test-key", { auth: llmAuthHeader, model: llmRequest?.model });

check("toggle: re-injection hides panel", result.afterHide?.present && result.afterHide?.hidden, result.afterHide);
check("toggle: third injection shows panel again", result.afterShow?.present && result.afterShow?.hidden === false, result.afterShow);

const g = result.drag || {};
check("desktop: panel anchored left/top for natural resize", g.anchored);
check("7 resize zones (no north midline — bar top is drag)", g.handles === 7, g.handles);
check("hit-test: bar top-center drags, upper corners resize", g.topCenter === "bar" && /pageaid-rz-nw/.test(g.topLeft || "") && /pageaid-rz-ne/.test(g.topRight || ""), { topCenter: g.topCenter, topLeft: g.topLeft, topRight: g.topRight });
check("west-edge resize grows leftward, right edge planted", Math.abs(g.resizeDw - 100) <= 10 && Math.abs(g.resizeDl - -100) <= 10 && g.resizeRightPlanted, { dw: g.resizeDw, dl: g.resizeDl });
check("drag by bar moves panel (−140, +90)", Math.abs(g.dx - -140) <= 20 && Math.abs(g.dy - 90) <= 20, { dx: g.dx, dy: g.dy });
check("real pointer press on title collapses (drag doesn't)", g.collapsed, g);
check("collapse stays in place and shrinks", g.collapsedStaysPut && g.collapsedShrank, g);
check("second title press re-expands", g.expandedAgain);

const k = result.dock || {};
check("dock setting: title press docks pill to bottom-right", k.collapsed && k.dockBR, k);
check("dock setting: expanding restores prior position", k.restored && k.expanded, k);

for (const name of ["1-panel-open", "2-answer", "3-dragged"]) {
  const f = shots[name];
  const size = f ? statSync(f).size : 0;
  check(`screenshot ${name}.png saved (${(size / 1024).toFixed(0)} KB)`, size > 10000, f || "missing");
}

console.log(failures === 0 ? `\n✅ All checks passed. Screenshots: ${ARTIFACTS}` : `\n❌ ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
