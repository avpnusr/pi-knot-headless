# Changelog

## [0.2.0] - 2026-11-21

- Ended page: outcome line and usage line (tokens, list-price estimate, `≥` while unresolved) from pi-subagents' cost data.
- Nested fan-out count per subagent row and in the outcome line.
- Optional, opt-in LLM summarizer (`summarizer` setting, no default model): one-sentence summary, optional page title, strict input allow-list, rate limits, own usage accounting.
- Page rename via the Knot API for the summarizer title.

## [0.1.0] - 2026-11-21

- First release: live Knot page per pi session (head model, subagents, decisions), `knot_ask` tool with minor/normal/critical severity, answers via comments by the configured owner, settings.json configuration, secret redaction, inert in subagent children and print mode.
