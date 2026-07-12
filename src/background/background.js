// Ask This Page — background (event page).
// Owns the LLM call, keeping the API key out of page context and centralizing
// provider logic, and injects the panel on toolbar click / hotkey. activeTab
// means the click itself grants access to the current tab, so there are no
// host permissions and no content scripts declared in the manifest.
//
// Two provider shapes:
//   - "openai": any OpenAI-compatible /v1/chat/completions endpoint
//     (OpenAI, GLM/Z.ai, Gemini OpenAI-compat, OpenRouter, Groq, Ollama, LM Studio)
//   - "anthropic": native Claude Messages API (/v1/messages)
// Streams tokens back to the panel over the connection port.

const DEFAULTS = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  anthropicVersion: "2023-06-01",
  systemPrompt:
    "You answer questions about a web page the user is viewing, grounded in the page text " +
    "provided in the first message. Answer in tight, skimmable markdown, preferring concrete " +
    "detail from the page over generalities. If the page text doesn't contain the answer, say " +
    "so briefly instead of guessing.",
  maxTokens: 1500,
  // Guard against pathological pages blowing past context windows / cost.
  // ~4 chars/token, so 320k chars ~= 80k tokens. Trim from the middle if longer.
  maxPageChars: 320000,
};

async function getConfig() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

function trimText(text, maxChars) {
  if (text.length <= maxChars) return text;
  // Keep the head and tail (intro + conclusion usually matter most); mark the cut.
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    "\n\n[… page text trimmed for length …]\n\n" +
    text.slice(text.length - half)
  );
}

// ---- provider request builders ----

function buildRequest(cfg, system, messages) {
  if (cfg.provider === "anthropic") {
    return {
      url: `${cfg.baseUrl.replace(/\/$/, "")}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": cfg.anthropicVersion,
        // Extensions bypass CORS via host permissions, but this header is the
        // sanctioned BYO-key browser path and harmless to include.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system,
        stream: true,
        messages,
      },
      parse: parseAnthropicSSE,
    };
  }
  // OpenAI-compatible
  return {
    url: `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      stream: true,
      messages: [{ role: "system", content: system }, ...messages],
    },
    parse: parseOpenAISSE,
  };
}

// ---- SSE delta parsers: return the text delta from one SSE data line ----

function parseOpenAISSE(json) {
  return json?.choices?.[0]?.delta?.content || "";
}
function parseAnthropicSSE(json) {
  if (json?.type === "content_block_delta" && json.delta?.type === "text_delta") return json.delta.text || "";
  return "";
}

// ---- streaming driver ----

// One streaming LLM call. Returns the full text; onDelta fires per chunk.
// Throws with a user-presentable message on any failure.
async function callLLM(cfg, system, messages, onDelta) {
  const req = buildRequest(cfg, system, messages);
  let res;
  try {
    res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    throw new Error(`Network error reaching the LLM endpoint: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM endpoint returned ${res.status}. ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; process complete lines.
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const delta = req.parse(json);
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      }
    }
  } catch (e) {
    throw new Error(`Stream interrupted: ${e.message}`);
  }
  return full;
}

// ---- the ask flow ----

// The page snapshot is the first user turn, a canned acknowledgement stands in
// as the assistant's reply, then prior Q&A turns and the new question follow.
// The panel resends everything each time, so the background stays stateless.
function buildDoc(msg, cfg) {
  let doc = `Page title: ${msg.title || "Untitled"}\nURL: ${msg.url || ""}\n\n`;
  if (msg.selection)
    doc += `Text the user highlighted on the page:\n\n${msg.selection.slice(0, 20000)}\n\n---\n\n`;
  doc += `Page text:\n\n${trimText(msg.pageText || "", cfg.maxPageChars)}`;
  return doc;
}

async function streamAsk(port, cfg, msg) {
  const messages = [
    { role: "user", content: buildDoc(msg, cfg) },
    { role: "assistant", content: "I've read the page. What would you like to know?" },
  ];
  for (const turn of msg.qa || []) {
    messages.push({ role: "user", content: turn.q });
    messages.push({ role: "assistant", content: turn.a });
  }
  messages.push({ role: "user", content: msg.question });
  const full = await callLLM(cfg, cfg.systemPrompt, messages, (d) => port.postMessage({ type: "chunk", text: d }));
  port.postMessage({ type: "done", text: full });
}

// ---- port wiring ----

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "ask") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "ask") return;
    const cfg = await getConfig();
    if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
      port.postMessage({
        type: "error",
        error: "No API key configured. Click the ⚙ in this panel to open settings and add a provider + API key. The settings page links to where to get one; Google Gemini has a free tier.",
      });
      return;
    }
    try {
      await streamAsk(port, cfg, msg);
    } catch (e) {
      port.postMessage({ type: "error", error: e.message });
    }
  });
});

// Expose defaults to the options page; open settings on behalf of the panel
// (content scripts can't call openOptionsPage themselves).
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "getDefaults") return Promise.resolve(DEFAULTS);
  if (msg?.type === "openOptions") browser.runtime.openOptionsPage();
});

// ---- panel injection ----

async function inject(tab) {
  try {
    await browser.tabs.insertCSS(tab.id, { file: "/content/panel.css" });
    await browser.tabs.executeScript(tab.id, { file: "/content/panel.js" });
  } catch (e) {
    // Privileged pages (about:*, addons.mozilla.org, the PDF viewer…) refuse
    // injection; flash the badge so the click isn't a silent no-op.
    console.warn("[ask-this-page] cannot inject:", e.message);
    try {
      await browser.browserAction.setBadgeText({ text: "✕", tabId: tab.id });
      setTimeout(() => browser.browserAction.setBadgeText({ text: "", tabId: tab.id }).catch(() => {}), 2500);
    } catch {}
  }
}
browser.browserAction.onClicked.addListener(inject);
