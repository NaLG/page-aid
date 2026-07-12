# Page Aid

Pop up a panel on any web page, ask a question about it, and get an answer from
the model of your choice — through your own API key. No backend, no account, no
tracking. The only thing that leaves your browser is the page text you send to
the endpoint you chose.

Sibling project of [Return YouTube Summary](https://github.com/NaLG/yt-sum) and
built on its BYOK engine; this one works on every page and answers *your*
question instead of auto-summarizing.

## How it works

1. Click the toolbar button (or press `Alt+Shift+A`).
2. A panel opens with a question field. The page's text is captured at that
   moment; anything you had highlighted is included and flagged as such.
3. Type a question — or hit the **Summarize this page** chip — and the answer
   streams into the panel. Follow-ups continue the conversation.

## Least privilege by design

- **`activeTab` only.** Clicking the button is what grants access, to that tab
  alone. No host permissions, no content scripts lurking on every page you visit.
- **LLM endpoints are optional permissions**, granted one host at a time the
  first time you save or test that provider.
- **Your API key** lives in `storage.local` and is sent only to the endpoint you
  chose. See [PRIVACY.md](PRIVACY.md).

## Providers (BYOK)

Two shapes cover essentially everything, configured in Settings:

- **OpenAI-compatible** (`/v1/chat/completions`): OpenAI, GLM/Z.ai, Google Gemini
  (OpenAI-compat endpoint), OpenRouter, Groq, and local **Ollama** / **LM Studio**.
- **Anthropic** (native `/v1/messages`): Claude models directly.

> Why BYO key and not "sign in with your subscription"? Because we're all tired
> and sick of Subscription culture. Pay only pennies for the inference required;
> let software be free.

## Develop

```sh
npm install
npm run lint          # web-ext lint
npm run run:desktop   # launch Firefox with the extension loaded
npm run build         # build the zip into dist/
```

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 nalg.
