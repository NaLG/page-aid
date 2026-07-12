// Page Aid — injected panel. Runs when the user clicks the toolbar button
// or presses the hotkey; activeTab grants access to this tab for exactly that
// gesture. The file is re-executed on every click, so the guard below turns
// repeat clicks into a show/hide toggle that keeps the conversation.

(() => {
  if (window.__pageAid) {
    window.__pageAid.toggle();
    return;
  }

  // ---- page snapshot ---------------------------------------------------------
  // Taken once, at the click. innerText already skips scripts, styles, and
  // hidden nodes; prefer the page's main landmark when it carries real content.
  function extractPage() {
    const selection = String(window.getSelection() || "").trim();
    const main = document.querySelector("main, [role='main'], article");
    let text = ((main && main.innerText) || "").trim();
    if (text.length < 500) text = ((document.body && document.body.innerText) || "").trim();
    return {
      title: document.title,
      url: location.href,
      selection,
      text: text.replace(/\n{3,}/g, "\n\n"),
    };
  }
  const page = extractPage();
  const qa = []; // conversation turns; the whole history is resent per question

  // ---- safe markdown rendering ----------------------------------------------
  // Model output injected into someone else's page, so we NEVER use innerHTML
  // with it. Every node is built with textContent (and hrefs are
  // scheme-checked), making injection impossible while still formatting.

  function cleanText(t) {
    return String(t)
      .replace(/<\|[^|>]*\|>/g, "")            // <|end_of_turn|>-style special tokens
      .replace(/<_[^>]*_>/g, "")               // <_ ... _> markers
      .replace(/\b(?:end_?of_?turn|ofturn)_?\b/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function renderInline(text, parent) {
    const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] || m[3]) { const el = document.createElement("strong"); el.textContent = m[2] || m[3]; parent.appendChild(el); }
      else if (m[4]) { const el = document.createElement("em"); el.textContent = m[4]; parent.appendChild(el); }
      else if (m[5]) { const el = document.createElement("code"); el.textContent = m[5]; parent.appendChild(el); }
      else if (m[6] && m[7]) {
        if (/^https?:\/\//i.test(m[7])) {
          const a = document.createElement("a");
          a.href = m[7]; a.textContent = m[6]; a.target = "_blank"; a.rel = "noopener noreferrer";
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(m[0])); // unsafe scheme -> literal
        }
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(md, container) {
    container.classList.remove("pageaid-error");
    container.textContent = "";
    const lines = cleanText(md).split("\n");
    let list = null, listTag = null;
    const endList = () => { list = null; listTag = null; };
    for (const line of lines) {
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        endList();
        const el = document.createElement("h" + Math.min(Math.max(m[1].length + 1, 3), 6)); // #→h3, ##→h3, ###→h4
        renderInline(m[2], el);
        container.appendChild(el);
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        if (listTag !== "ul") { list = document.createElement("ul"); container.appendChild(list); listTag = "ul"; }
        const li = document.createElement("li"); renderInline(m[1], li); list.appendChild(li);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (listTag !== "ol") { list = document.createElement("ol"); container.appendChild(list); listTag = "ol"; }
        const li = document.createElement("li"); renderInline(m[1], li); list.appendChild(li);
      } else if (line.trim() === "") {
        endList();
      } else {
        endList();
        const p = document.createElement("p"); renderInline(line, p); container.appendChild(p);
      }
    }
  }

  // ---- background bridge ------------------------------------------------------
  // The LLM call runs in the background script (keeps the API key out of page
  // context). Streaming chunks arrive via a port; returns the final text.
  function requestLLM(payload, { onChunk } = {}) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "ask" });
      let acc = "";
      port.onMessage.addListener((msg) => {
        if (msg.type === "chunk") {
          acc += msg.text;
          onChunk?.(msg.text);
        } else if (msg.type === "done") {
          resolve(msg.text ?? acc);
          port.disconnect();
        } else if (msg.type === "error") {
          reject(new Error(msg.error));
          port.disconnect();
        }
      });
      port.postMessage(payload);
    });
  }

  // ---- UI ----------------------------------------------------------------------

  const panel = document.createElement("div");
  panel.id = "pageaid-panel";
  panel.className = "pageaid-panel";

  const bar = document.createElement("div");
  bar.className = "pageaid-bar";
  // Title doubles as collapse/expand: fold the panel to a compact bar (in
  // place — it stays where you dragged it) while keeping the conversation.
  // ✕ only hides; the toolbar button re-shows it. A drag on the bar must not
  // fire the collapse toggle, so the drag handler raises this flag.
  let suppressTitleClick = false;
  const title = document.createElement("span");
  title.className = "pageaid-title";
  title.textContent = "Page Aid";
  title.title = "Collapse / expand (drag to move)";
  title.addEventListener("click", () => {
    if (suppressTitleClick) return;
    panel.classList.toggle("pageaid-collapsed");
  });
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "pageaid-gear";
  gear.textContent = "⚙";
  gear.title = "Settings";
  gear.addEventListener("click", () => browser.runtime.sendMessage({ type: "openOptions" }));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pageaid-close";
  close.textContent = "✕";
  close.title = "Hide (the toolbar button brings it back)";
  close.addEventListener("click", () => panel.classList.add("pageaid-hidden"));
  bar.append(title, gear, close);

  const body = document.createElement("div");
  body.className = "pageaid-body";
  const empty = document.createElement("div");
  empty.className = "pageaid-empty";
  const hint = document.createElement("p");
  hint.className = "pageaid-hint";
  hint.textContent = page.selection
    ? "Ask anything about this page — your highlighted text is included."
    : "Ask anything about this page.";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "pageaid-chip";
  chip.textContent = "Summarize this page";
  chip.addEventListener("click", () => ask("Summarize this page: a one-sentence TL;DR, then the key points as bullets."));
  empty.append(hint, chip);
  body.appendChild(empty);

  const askBar = document.createElement("div");
  askBar.className = "pageaid-ask";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Ask about this page…";
  const askBtn = document.createElement("button");
  askBtn.type = "button";
  askBtn.textContent = "Ask";
  askBar.append(input, askBtn);

  panel.append(bar, body, askBar);

  // ---- drag + placement -------------------------------------------------------
  // The panel starts CSS-anchored top-right. On desktop it is converted to
  // explicit left/top as soon as it exists (and at the latest on first drag):
  // a right-anchored box resizes mirrored — the native handle grows it away
  // from the pointer — and dragging needs concrete coordinates anyway.
  const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  function clampIntoView() {
    const r = panel.getBoundingClientRect();
    panel.style.left = clampNum(r.left, 80 - r.width, window.innerWidth - 80) + "px";
    panel.style.top = clampNum(r.top, 8, window.innerHeight - 48) + "px";
  }
  function anchorLeftTop() {
    if (panel.style.left) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = r.left + "px";
    panel.style.top = r.top + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    anchorLeftTop();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = parseFloat(panel.style.left), startTop = parseFloat(panel.style.top);
    let dragging = false;
    const move = (ev) => {
      // Sub-threshold movement stays a click (collapse toggle); beyond it,
      // it's a drag and the click that follows pointerup is swallowed.
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      dragging = true;
      panel.style.left = startLeft + (ev.clientX - startX) + "px";
      panel.style.top = startTop + (ev.clientY - startY) + "px";
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      if (dragging) {
        clampIntoView();
        suppressTitleClick = true;
        setTimeout(() => { suppressTitleClick = false; }, 0);
      }
    };
    // Capture keeps the drag alive when the pointer outruns the bar; synthetic
    // test events have no active pointer to capture, hence the try.
    try { bar.setPointerCapture(e.pointerId); } catch {}
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    e.preventDefault(); // no text selection while dragging
  });

  // ---- resize: all corners + edge midlines -------------------------------------
  // Zone letters encode which sides move: e/s grow width/height; w/n also shift
  // left/top so the opposite edge stays planted.
  const MIN_W = 280, MIN_H = 160; // keep in sync with panel.css min-width/height
  function startResize(e, zone) {
    if (e.button !== 0) return;
    anchorLeftTop();
    const r = panel.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const target = e.currentTarget;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let { left, top, width, height } = r;
      if (zone.includes("e")) width += dx;
      if (zone.includes("s")) height += dy;
      if (zone.includes("w")) { const d = Math.min(dx, width - MIN_W); left += d; width -= d; }
      if (zone.includes("n")) { const d = Math.min(dy, height - MIN_H); top += d; height -= d; }
      panel.style.width = Math.max(width, MIN_W) + "px";
      panel.style.height = Math.max(height, MIN_H) + "px";
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.maxHeight = "none"; // user override beats the default cap
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    try { target.setPointerCapture(e.pointerId); } catch {}
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    e.preventDefault();
    e.stopPropagation();
  }
  // No plain "n" zone: the bar's top edge belongs to dragging; the upper
  // corners still resize.
  for (const zone of ["s", "e", "w", "ne", "nw", "se", "sw"]) {
    const h = document.createElement("div");
    h.className = `pageaid-rz pageaid-rz-${zone}`;
    h.addEventListener("pointerdown", (e) => startResize(e, zone));
    panel.appendChild(h);
  }

  async function ask(question) {
    question = String(question || "").trim();
    if (!question || input.disabled) return;
    input.disabled = askBtn.disabled = true;
    body.querySelector(".pageaid-empty")?.remove();
    const qEl = document.createElement("p");
    qEl.className = "pageaid-qa-q";
    qEl.textContent = question; // textContent only, injection-safe
    const aEl = document.createElement("div");
    aEl.className = "pageaid-qa-a";
    aEl.textContent = "…";
    body.append(qEl, aEl);
    aEl.scrollIntoView({ block: "nearest" });
    try {
      let acc = "", lastRender = 0;
      const answer = await requestLLM(
        { type: "ask", title: page.title, url: page.url, selection: page.selection, pageText: page.text, qa, question },
        {
          onChunk: (c) => {
            acc += c;
            const now = Date.now();
            if (now - lastRender > 80) { lastRender = now; renderMarkdown(acc, aEl); } // live, throttled
          },
        }
      );
      const finalAnswer = answer != null ? answer : acc;
      renderMarkdown(finalAnswer, aEl); // final clean render
      qa.push({ q: question, a: finalAnswer });
      input.value = "";
    } catch (e) {
      aEl.classList.add("pageaid-error");
      aEl.textContent = `Ask failed: ${e.message}`;
    }
    input.disabled = askBtn.disabled = false;
    input.focus();
  }

  askBtn.addEventListener("click", () => ask(input.value));
  // Keep the host page's global hotkeys away from the field; Enter asks,
  // Escape hides the panel.
  for (const ev of ["keydown", "keyup", "keypress"]) {
    input.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev !== "keydown") return;
      if (e.key === "Enter") { e.preventDefault(); ask(input.value); }
      if (e.key === "Escape") { e.preventDefault(); panel.classList.add("pageaid-hidden"); }
    });
  }

  function toggle() {
    const hidden = panel.classList.toggle("pageaid-hidden");
    if (!hidden) {
      panel.classList.remove("pageaid-collapsed");
      if (panel.style.left) clampIntoView(); // viewport may have changed while hidden
      input.focus();
    }
  }

  document.body.appendChild(panel);
  // Mobile keeps the pure-CSS bottom-sheet layout (inline coordinates would
  // fight the media query); desktop anchors immediately for natural resizing.
  if (window.innerWidth > 640) anchorLeftTop();
  input.focus();
  window.__pageAid = { toggle };
  console.log("[page-aid] panel injected on", location.href);
})();
