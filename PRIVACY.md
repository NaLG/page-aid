Page Aid Privacy Policy

Last updated 2026-07-14. Publisher: nalg.

Short version: this extension has no servers and collects nothing for its developer. The only place your data goes is the LLM endpoint you configure.

What it does

Clicking the toolbar button (or pressing the hotkey) opens a panel on the current page. When you ask a question, the page's visible text and title — plus any text you had highlighted — are sent with your question to the AI endpoint you configured in settings, using the API key you supplied. The answer is shown in the panel. Follow-up questions resend the page text and prior turns to the same endpoint.

Data it handles, and where it goes

- Page text and title (website content): read from the page you invoked the panel on and transmitted only to the endpoint you configured. Never sent to the developer or to any party you did not configure. This is the manifest's declared websiteContent collection.
- Your API key (authentication info): stored locally in the browser's extension storage and sent only to your configured endpoint, as the credential for your own requests. Never sent to the developer. This is the declared authenticationInfo collection.
- Your settings (provider, endpoint URL, model, system prompt, limits): stored locally on your device only.

There is no developer server. The extension makes network requests only to the endpoint you chose, and only when you ask a question.

What it never does

- No analytics, telemetry, tracking, advertising, or fingerprinting.
- No collection of browsing history, identity, location, or contacts.
- No cookies, no selling or sharing data with anyone.
- It reads a page only when you invoke it there; it does not watch your browsing.

Permissions

- activeTab: access to the current tab is granted by your click (or hotkey), for that tab only. There is no standing access to any site, and nothing runs on pages where you haven't invoked it.
- Optional host access to LLM API endpoints: nothing is granted at install. When you configure a provider, Firefox asks you to allow access to that one host, and only it. The broad any-site option is likewise opt-in and exists for custom endpoints you enter yourself.
- storage: saves your settings and key locally.

Third-party providers

Because you choose the endpoint (OpenAI, Google Gemini, Anthropic, OpenRouter, Groq, a local model), the page text you submit is processed under that provider's own privacy policy and terms. The extension has no control over what your chosen provider does with data you send it. Fully local models (Ollama, LM Studio) keep data on your machine.

Your control

Everything is local. Removing the extension deletes its stored settings and key. You can change or clear the endpoint and key at any time in settings.

Changes

Updates to this policy are published in the extension's source repository with a new date.

Contact

Open an issue on the project's GitHub repository (publisher nalg).
