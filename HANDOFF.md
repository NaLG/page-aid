# HANDOFF — Page Aid

Skeleton extracted from yt-sum (Return YouTube Summary) on 2026-07-12. Git
history was intentionally dropped: this tree started as a copy of yt-sum@5a32ff6
with all the YouTube/transcript machinery removed.

## What this is

Firefox extension: toolbar button / `Alt+Shift+A` pops a panel on the current
page with a question field; page text + question stream through the user's own
LLM key. Same BYOK engine as yt-sum (OpenAI-compatible + native Anthropic).

## State

- Skeleton complete; lints clean. End-to-end smoke test PASSES in real Firefox
  (`npm run test:smoke`): mock OpenAI SSE endpoint on localhost, 26 assertions
  covering injection, <main> extraction (sentinel in the request, nav junk out),
  streaming markdown render, toggle guard, drag/collapse-in-place/resize-handle,
  plus PNG screenshots relayed to test/artifacts/ for visual review. The activeTab toolbar-click gesture is the
  one path the harness can't drive (test build pre-grants <all_urls> instead) —
  verify with one manual click.
- Name DECIDED 2026-07-12: "Page Aid" (id `page-aid@nalg.dev`). Known close
  neighbors on AMO: "Page Assist" (~9k users) and "AI Page Assistant" — judged
  distinct enough; owner picked the name before finding Page Assist.
- Icons are yt-sum's, as placeholders.
- No GitHub repo yet (`gh repo create` when ready). The directory on this
  machine is still named `yt-sum`.

## Architecture (what changed vs yt-sum)

- No content_scripts, no webRequest. `activeTab` + browserAction.onClicked →
  tabs.insertCSS + tabs.executeScript inject content/panel.{css,js} on demand.
  Repeat clicks toggle the panel (window.__pageAid guard). Least-privilege
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

- Manual once-over (`npm run run:desktop`): toolbar click + Alt+Shift+A — the
  real activeTab gesture — then a heavy SPA, the no-key error path, a privileged
  page (badge flash), and one real-LLM round trip (localhost Ollama or a key).
- Icons.
- Android: needs an Android emulator/SDK setup (none on this machine). Re-add a gecko_android block there
  and check popup-less browserAction.onClicked behavior on Fenix.
- Maybe: re-snapshot control ("↻ page changed?"), per-tab conversation cache
  like yt-sum's summaryCache, context-menu "Ask about selection".
