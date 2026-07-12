# HANDOFF — Ask This Page

Skeleton extracted from yt-sum (Return YouTube Summary) on 2026-07-12. Git
history was intentionally dropped: this tree started as a copy of yt-sum@5a32ff6
with all the YouTube/transcript machinery removed.

## What this is

Firefox extension: toolbar button / `Alt+Shift+A` pops a panel on the current
page with a question field; page text + question stream through the user's own
LLM key. Same BYOK engine as yt-sum (OpenAI-compatible + native Anthropic).

## State

- Skeleton complete; lints clean. Not yet exercised in a real browser session.
- Working name "Ask This Page" (id `ask-this-page@nalg.dev`) is a PLACEHOLDER —
  final name TBD. Rename points: manifest (name/id), package.json, README,
  PRIVACY, options.html copy, panel title in content/panel.js, this file.
- Icons are yt-sum's, as placeholders.
- No GitHub repo yet (`gh repo create` when ready). The directory on this
  machine is still named `yt-sum`.

## Architecture (what changed vs yt-sum)

- No content_scripts, no webRequest. `activeTab` + browserAction.onClicked →
  tabs.insertCSS + tabs.executeScript inject content/panel.{css,js} on demand.
  Repeat clicks toggle the panel (window.__askThisPage guard). Least-privilege
  install prompt: storage + activeTab only.
- background.js keeps yt-sum's LLM engine (buildRequest / SSE parsers / callLLM)
  verbatim; transcript capture and map-reduce chunking are gone. One "ask" port
  replaces summarize/followup; the panel resends page text + full Q&A history
  each turn, so the background stays stateless.
- Page text: snapshotted at click time in panel.js — main/[role=main]/article
  landmark preferred (body.innerText fallback when thin), selection captured
  and flagged separately in the prompt.
- Options page: provider presets / live model loader / test connection carried
  over unchanged; buttonStyle removed; maxTranscriptChars → maxPageChars.

## Next

- Name decision, then rename (see State).
- Real-browser smoke test: `npm run run:desktop`, panel on a heavy SPA, error
  paths (no key; privileged page → badge flash), a localhost Ollama round trip.
- Icons.
- Decide whether Android is a target (yt-sum's gecko_android manifest block was
  dropped; browser_action popup-less onClicked needs checking on Fenix).
- Maybe: re-snapshot control ("↻ page changed?"), per-tab conversation cache
  like yt-sum's summaryCache, context-menu "Ask about selection".
