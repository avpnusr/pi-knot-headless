# Changelog

## [Unreleased]

## [0.2.2] - 2026-11-22

- **"Nothing needs you" is now checkable.** The page header names the state (`running`, `waiting on you: Q1`, `idle — no open question`) and the empty *Needs you* section states the heartbeat time and that an old heartbeat means a stale page. When a run settles, the last assistant message is shown (*Last agent message*). If it asks something in the chat instead of via `knot_ask`, it is mirrored as a critical, answerable question (even if no page existed yet) and dropped when you continue in the chat. Keyword heuristic, see README Limitations.

- **Subagent and nested costs reach the page.** The cost is now re-read a few seconds after every subagent completion and once more before the final write (it was only read when the head's turn settled, so subagents that finished later were missing). Nested runs, which pi-subagents' cost report never includes, get their own `nested runs` line: input/output tokens from the nested event files and the list-price estimate from each finished run's `status.json`. Both lines now also show while the session runs, in a *Usage so far* section.

- **Task column for scripted workflows.** Workers of a scripted workflow (`workflow: true`) now show a task excerpt instead of just the step label. It is read from the `sessionName` pi-subagents stores in the workflow's `status.json` (found through the `asyncDir` of the `subagent:async-started` event; read-only, validated path, size cap). Launch-argument text still wins when available.

## [0.2.1] - 2026-11-21

- **Nested fan-out count works live.** pi-subagents' status snapshot never carried nested runs for async launches (it drops the nested route), so `+N nested` never appeared. The count is now read from the nested-event files via the `nestedRoute` of the `subagent:async-started` event (read-only, validated path, size and count caps, nothing of the route is stored or written to the page), merged with the snapshot count. Async launches only. Upstream cause: nicobailon/pi-subagents#3316.
- **Knot rule enforced in code.** `knot_ask` now carries the rule that questions, approval gates and choices coming from skills (brainstorming, writing-plans, code-review, ...) must also go through `knot_ask`, so it reaches the system prompt in every session without relying on `AGENTS.md`. Inert in subagent children and whenever reporting is not active.
- **Task column filled for every launch style.** Subagents launched directly (`{agent, task}`) and `tasks` launches now show their task text (pi-subagents' fleet status never provides one), matched to the row by agent and start time. Chain/`tasks` launches that pi-subagents compiles into workflows get their texts too; scripted workflows show the step label. A workflow that failed before starting any worker no longer appears as an empty Orchestrator group.

## [0.2.0] - 2026-11-21

- **Orchestrator groups.** A pi-subagents workflow is now shown as `Orchestrator N` with its own table of workers (and their task text) instead of a bare `workflow` row plus unrelated worker rows. Directly launched subagents get a separate `Direct subagents` table. Running orchestrators and the last finished one stay expanded; older finished ones shrink to one line. Without the pi-subagents tree snapshot the Agents section looks as before.
- **Security hardening** (independent Opus review, round 1 and 2):
  - the summarizer input and replies are redacted before they are truncated; more token formats are redacted (GitHub fine-grained PATs, Stripe, GitLab, npm);
  - a reply in a closed question's thread is no longer presented as an answer to another open question;
  - if the page creator equals `ownerUid` (agent and owner share an account) inbound Knot answers are disabled, `knot_ask` says so, and the warning repeats on every start;
  - restored page ids are validated, comment responses are size-capped and shape-checked, an in-flight poll cannot swallow an answer at shutdown, the comment cursor is restored session-wide, URLs ending in a bare `?`/`#` are rejected;
  - question comments are defanged more strictly (runs of `//`, `www.`, `<`, reference-link definitions) and are cut at a character boundary.
- Ended page: outcome line and usage line (tokens, list-price estimate, `≥` while unresolved) from pi-subagents' cost data.
- Nested fan-out count per subagent row and in the outcome line.
- Optional, opt-in LLM summarizer (`summarizer` setting, no default model): one-sentence summary, optional page title, strict input allow-list, rate limits, own usage accounting.
- Page rename via the Knot API for the summarizer title.

## [0.1.0] - 2026-11-21

- First release: live Knot page per pi session (head model, subagents, decisions), `knot_ask` tool with minor/normal/critical severity, answers via comments by the configured owner, settings.json configuration, secret redaction, inert in subagent children and print mode.
