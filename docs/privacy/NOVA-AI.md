# NOVA AI — privacy and data handling

NOVA AI is **off by default**. Until you click *Enable NOVA AI*, the main process refuses every AI request (`AI_ERROR: NOVA AI is turned off`) and nothing is sent anywhere.

## Where requests go
- All AI network requests are made by NOVA's **main process**. The renderer (UI) has no network access to providers and never sees API keys.
- You choose the provider: **Ollama-compatible** (default `http://127.0.0.1:11434`; stays on this machine) or any **OpenAI-compatible** HTTP endpoint (OpenAI, Azure-compatible gateways, LM Studio, vLLM, OpenRouter, a local Ollama `/v1`, …). The panel and every preview say whether the endpoint is local or remote.
- Requests to `localhost`/`127.0.0.1`/`::1` use Node's fetch (no proxy). Everything else goes through Chromium's network stack and follows the system proxy settings.

## What is sent — and when
1. You ask (chat, explain selection, explain error, generate tests, document function, inline edit).
2. Main builds the request and shows a **preview**: provider, model, URL, the exact `messages` array, which sources were included (with character counts and redactions) and which files were **not sent and why**.
3. Only when you click *Send to …* is that exact payload sent. Nothing is attached automatically except what the action names (the selection, the diagnostic, or the files/terminal output you ticked). If enabled in settings, earlier *chat* turns of this workspace are included (visible in the preview).

## What is never sent
- **Sensitive files** (decided by name before the file is read): `.env`, `.env.*`, `*.env`, `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`, `id_rsa`/`id_ed25519`…, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `*.gpg`, `*.asc`, `*.crt`, `credentials*`, `secret(s)*`, `*secrets.json|yaml|toml|ini|txt`, `service-account*.json`, `terraform.tfstate`, `.htpasswd`, and anything under `.git/`, `.ssh/`, `.aws/`, `.gnupg/`, `.azure/`, `.kube/`, `.docker/`, `node_modules/`. A *selection* from such a file is not sent either.
- Files matched by the workspace `.gitignore` or a `.novaaiignore` (same syntax).
- **Binary** files (NUL bytes) and **oversized** files (> 100 KB; checked by size before reading).

## Redaction
All included text (files, selections, diagnostics, terminal output) passes through secret redaction: private-key blocks, AWS access keys, GitHub tokens, `sk-…` keys, Slack tokens, Google API keys, Stripe keys, JWTs, `Bearer …` tokens, passwords in URLs, and `password/secret/token/api_key/… = value` assignments become `[REDACTED:kind]`. Redaction is pattern-based: it reduces risk, it cannot guarantee that every secret is caught — the preview is the final check.

## API keys
- Stored with Electron `safeStorage`, i.e. encrypted by the OS keychain (Windows DPAPI, macOS Keychain, Linux libsecret/KWallet), in `<userData>/ai/ai-keys.json` as ciphertext. Never written in plaintext, never sent to the renderer, masked (`Bearer ***`) in the audit log.
- If no real OS keyring is available (Linux without libsecret/KWallet, where Chromium would fall back to a hard-coded key), NOVA **refuses to store the key** and says why.

## History
- Stored locally per workspace in `<userData>/ai/history/<hash-of-workspace-path>.json` (last 200 entries). *Clear AI history* deletes the file. History is never uploaded except as earlier chat turns you can see in the preview.

## Prompt injection
- Workspace, diagnostic and terminal text is wrapped as `<untrusted_data source="…">…</untrusted_data>`; text that tries to close or forge the wrapper is escaped. The system prompt tells the model never to follow instructions inside it.
- This is a mitigation, not a guarantee. The real protection is that **the model has no tools**: its output cannot read files, change files or run anything. Inline edits are shown as a diff and change nothing until you accept hunks and click *Apply*. Proposed shell commands are only displayed; they run only if you click *Run in terminal…*, confirm, and the workspace is trusted.

## Audit log (optional)
Set `NOVA_AI_REQUEST_LOG=/path/file.jsonl` to append every request exactly as sent (URL, headers with the key masked, JSON body). Used by the E2E test to prove `.env` content is never sent.
