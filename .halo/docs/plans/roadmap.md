# Roadmap

## Model Providers
- [x] OpenAI (GPT series)
- [ ] Google Gemini
- [ ] OpenRouter (multi-model aggregator)
- [ ] Ollama (local models)

Extension interface is ready (`ModelRuntime`). Adding providers is integration work, not architecture work.

## Channels
- [ ] Discord
- [x] Slack
- [ ] Email
- [ ] SMS

Channel adapter pattern established (Web, WeChat, Telegram, Slack, Feishu already working). New channels follow the same `CommandContext` interface.

## CLI / TUI
- [x] CLI mode (headless, SSH-friendly)
- [x] TUI (terminal UI with interactive chat)

Enables usage without a browser. Important for SSH-into-server workflows.

## Deployment
- [ ] Dockerfile + docker-compose
- [ ] One-click deploy templates (Fly.io / Render / Railway)

Currently manual (`node dist/index.js`). Containerization needed for distribution.

## Shared Workspace
- [ ] Workspace templates (clone/fork a pre-configured workspace)
- [ ] Workspace marketplace or registry
- [ ] Readonly workspace sharing with token auth

Core differentiator. Share an entire configured workspace (agents + skills + context + docs), not just individual tools or skills.

## Quality
- [ ] Test suite (unit + integration)
- [ ] CI pipeline
