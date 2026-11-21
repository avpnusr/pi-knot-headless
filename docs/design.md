# pi-knot-headless — headless session dashboard in Knot

Date: 2026-11-21 · Status: **rev 4 (after the Opus-5-5 code and security review of v0.1.0)** · Approach chosen by user: **B (extension only)**

## Intent and why
The user runs pi sessions "headless": watch status and answer questions from a Knot wiki
(self-hosted, e.g. `https://knot.example.com`) instead of the terminal. Each session gets one subpage under
a configurable parent page (`parentPageId`) showing who is doing what, what needs the user,
and what the model decided. The user's comments on the page flow back into the session.

## Goals
- One subpage per session, titled `<folder> · <speaking name>`, kept one screen long.
- Head model + every subagent: colored identity dot, model, state, task.
- Questions that need the user; the answer is delivered to the session.
- Every decision the model reports is on the page (👤 user / 🤖 model / ⏱ timeout default).
- Every future session uses it without relying on the model's memory.

## Non-goals / anti-goals
- No LLM in the render/poll loop. Optional LLM summarizer / nicer names (**approach C**) is deferred: **ask the user about C when v1 is done.**
- **No checkboxes, no reading the page body.** The body is a write-only dashboard (user decision 2026-11-21).
- No Knot tools in child subagents; no page rename/archive/cleanup, no crash registry, no timeline chips, no live token/elapsed counters, no `knot_status` tool (all cut for v1).
- Anti-goals: leaking secrets to the page; any third party steering the session; re-running an old instruction.

## Constraints (verified)
- Knot API (Bearer): `POST /api/docs` (create), `POST /api/docs/{id}/markdown?mode=replace` (full rewrite, 204; **without `mode=replace` it merges**), `GET /api/docs/{id}/comments`, `POST /api/docs/{id}/comments {"body"}`. Comments live outside the body, survive rewrites, carry server-set `author_id`, `id`, `created_at`, `thread_id`, `parent_id`. **Verified 2026-11-21:** the user's reply to my comment appears with their `author_id` `<YOUR_KNOT_USER_ID>`, `parent_id` = my comment. The bot account is `<BOT_USER_ID>`. Pages under AI Task-List have restricted permissions (user confirmed).
- **Cheap checks done 2026-11-21:**
  - (1) `pi.sendUserMessage(text,{deliverAs:"steer"})` on an **idle** session starts a turn at once (verified in `--mode rpc` with a throwaway extension; interactive TUI uses the same path per docs, not separately run).
  - (2) 494 sequential full rewrites (~2 KB): latency flat (0.29 s → 0.30 s), `/markdown` stays 764 B, then **HTTP 429** (rate limit; cleared within seconds, no `Retry-After` header seen, 120 more rapid writes later passed). Server-side Yjs document size could not be measured (workspace export needs owner rights). With ≥15–30 s spacing and skip-if-unchanged, v1 does ≤240 writes/h. `knot.ts` must treat 429 as backoff-and-retry.
- **Live checks (Task 7, 2026-11-21, real `pi --mode rpc`, model glm-5.3-flash):** `knot_ask` (critical) returned in 1.2 s; the page was created with `Needs you`/`Q1`; a thread reply `2` (via `POST /api/docs/{id}/comments/{thread_id}/replies`) was delivered to the session as `the user answered: "blue"` and logged as 👤; two sessions in one folder got two separate pages; **SIGHUP and SIGTERM both wrote the final `✅ ended` page**; scratch pages archived.
- **Knot rule: bots cannot create pages below a *restricted* page** (`403 bot.restricted_forbidden`, documented in Knot's API-key plan: "Bots are refused … creating under a restricted parent"). Bots with editor rights can still edit existing restricted pages. So `parentPageId` must be an **unrestricted** page. The client turns this error into an explicit message.
- Knot comment API: `POST /api/docs/{id}/comments {body}` (top level), `POST /api/docs/{id}/comments/{thread_id}/replies {body}`; comment body ≤ 4096 bytes; `GET` hides resolved threads unless `?include_resolved`.
- The extension never delivers comments it posted itself (`ownIds`). If the page creator equals `ownerUid`, it persists `selfOwned`, warns on every session start/resume, and disables all inbound comment delivery: anyone holding the agent's token could otherwise forge an owner approval. Dashboard writes continue, but `knot_ask` tells the agent to ask directly until a separate bot token is used.
- `DELETE /api/docs/{id}` returns 204 and **archives** the page (`archived:true`, restorable). `PATCH /api/docs/{id}` renames (per earlier notes; not re-tested). Cleanup stays manual in v1 (user decision), but a later `/knot cleanup` is cheap.
- pi extension API (docs `extensions.md`): `registerTool` (tool `execute` may return `terminate: true`), `registerCommand`, events `session_start|session_shutdown(reason)|agent_settled|model_select|tool_execution_*`, `pi.sendUserMessage(text,{deliverAs})` (while streaming without `deliverAs` it is **rejected**; idle it sends and starts a turn; `expandPromptTemplates` default false), `pi.appendEntry`, `ctx.mode`, `ctx.model`, `ctx.cwd`, `ctx.sessionManager`, `ctx.ui.setStatus/notify`. Auto-discovery `~/.pi/agent/extensions/<name>/index.ts`, `/reload`.
- pi-subagents: **background children load ambient extensions inside the detached runner** (`extension-api.md` ~494); `PI_SUBAGENT_CHILD=1` marks them (inherited by processes they spawn). Local foreground children run in the parent process and do not load ambient extensions. `pi.events` is in-process, **not replayed** after restart. State source: in-process RPC `subagents:rpc:v1:request` method `status` (`data.fleet`, `asyncSnapshot`), fallback `status.json` under the `asyncDir` from event payloads (no hardcoded `/tmp` path). `lastUpdate` is not a heartbeat. Foreground children arrive as `tool_execution_update` of the `subagent` tool, keyed `(toolCallId, runId, index)`.
- Needs a long-lived interactive/RPC pi (e.g. tmux).
- Knot token: the env var is looked up in config `tokenEnv` by the provider of the model **at page creation** (`"*"` = fallback); the provider string (not the value) is stored with the page state and reused. Missing env var → disable with one `ctx.ui.notify`. Values never printed, logged, stored or rendered.

## Approaches considered
A. Pure LLM subagent — rejected (cannot inject into parent, burns quota, layout drifts). **B. Extension only — chosen.** C. B + small LLM summarizer — deferred, re-ask.

## Design

### Configuration (portable, nothing user-specific in code)
Read once at `session_start` from the `"pi-knot-headless"` block of the **global** `settings.json` (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`). **Project `.pi/settings.json` is ignored on purpose** (security review: a cloned repo could otherwise redirect `url`/`tokenEnv` and receive the token, or pick `ownerUid`). `pi.getSettings()` is not used because it merges project settings. Environment variables override the three connection keys.

| Key | Env override | Required | Meaning |
|---|---|---|---|
| `url` | `KNOT_URL` | yes | Knot base URL, `https` (plain `http` only for `localhost`), no trailing slash |
| `parentPageId` | `KNOT_PARENT_PAGE_ID` | yes | UUID of the page that holds all session subpages |
| `ownerUid` | `KNOT_OWNER_UID` | **yes** | Knot user id allowed to answer. No inference from the parent page any more (it could be a different bot). If it equals the creator of the page the agent made, the extension warns on every session start/resume and disables inbound Knot answers: anyone holding that token could otherwise answer as the owner |
| `tokenEnv` | – | no | `{ "<provider>": "ENV_VAR_NAME", "*": "ENV_VAR_NAME" }`; default `{ "*": "KNOT_TOKEN" }` |
| `secretEnv` | – | no | extra env var names whose values are scrubbed (all `tokenEnv` vars always are) |
| `askTimeoutMinutes` | – | no | timeout for `normal` questions, default 120 |
| `enabled` | – | no | default `true` |

Missing or invalid required keys → the extension stays inert, registers no tool, and the status line shows `knot: not configured` (`/knot status` names the key). Secrets (tokens) never live in settings, only env var **names**.

### Guards (first thing in the factory and every handler)
Inert (no tools, no timers, no network) if `process.env.PI_SUBAGENT_CHILD === "1"` or `PI_SUBAGENT_RUNNER_PID` is set, or `ctx.mode` is not `tui`/`rpc` (so `pi -p` never creates a page). Disabled via `/knot off`.

### Modules (`~/.pi/agent/extensions/knot-report/`)
`index.ts` (wiring, state, tools, command, single-flight I/O loop), `knot.ts` (API client: create, replace, comments, token pick, redaction, backoff; never throws into pi), `render.ts` (**pure** `render(state) → markdown`, snapshot-tested).

### Page (write-only dashboard; no moving parts)
Header (state, title, "started HH:MM", last heartbeat) → 🧠 head line (model, current activity) → **Needs you** (open questions with ids `Q1…` and numbered options `Q1.1 …`; empty = "nothing needs you 🎉") → agents table → **Decisions reported** (last 8 + "N older") → footer (how to answer).
- Identity dot per agent name, stable palette 🟣🔵🟢🟡🟠🟤 (hash of name); head 🧠. Status glyph separate, never a colored dot: ▶ working ✅ done ❌ failed ⏳ waiting for you 💤 idle ⏸ paused.
- **Page states:** ▶ running, 💤 idle ("comment to give a new task"; polling continues), ✅ ended (only on `session_shutdown` with `reason` ≠ `reload`). Ended page: outcome line, duration, models used, subagent table (final), decisions, cost via RPC `cost` (once). Note "N background runs still running; results not delivered" if detached runs remain.
- Writes: skip if markdown byte-identical to the last write; ≥15–30 s apart (trailing debounce); heartbeat line refreshed every 5 min; always `?mode=replace`.
- **Escaping:** all dynamic text is single-line and escaped (`[ ] | # > * \`` backticks, links); cells truncated (~80 chars). Only allow-listed fields are rendered: agent name, model, state, bounded label/goal, model-authored question/options/why, session name. Never tool arguments/outputs.
- **Redaction** on page, title and comments: exact values (≥8 chars) of the env vars in the AGENTS.md secret list; patterns `knot_…`, `Bearer \S+`, `sk-…`, `ghp_…`, `-----BEGIN`.

### Questions and decisions — `knot_ask`
Params: `question`, `options[]`, `recommended`, `severity: minor|normal|critical`, `why`. `normal` without `recommended` is rejected (or promoted to `critical`).
| severity | meaning | behavior |
|---|---|---|
| `minor` | easy, uncritical, reversible | Logged at once as 🤖 *decided by model*, no wait. User may override later via a comment (delivered as steer). |
| `normal` | real choice, reversible | Posted under Needs you; waits **2 h**, then the extension sends the timeout message and logs ⏱ *auto-decided*. |
| `critical` | hard, irreversible, destructive, security, spend, publishing, unclear requirement | Posted; waits **indefinitely**, no default. Tool returns `terminate: true`. |
Model rule (tool `promptGuidelines`): when unsure choose the higher severity; call `knot_ask` alone in its tool batch.
- **Non-blocking:** `knot_ask` returns at once (“posted as Q3; stop dependent work; the answer arrives as a user message”). The extension also posts a **comment** on the page for each open question (question + numbered options); the user replies in that thread. Deadlines persisted via `appendEntry`, restored on start.
- Child questions: head model replies to children with `subagent_supervisor({action:"reply", replyTo})`; put `replyTo` in `why`. Children of `async:false` workflows cannot receive replies (say so in the delegation playbook line).
- Delivered messages are **self-contained**: question, options, recommended, user's answer, `why`. Timeout text: “Q3 unanswered on Knot after 2 h; if the user already decided this elsewhere keep that, otherwise proceed with <default>”.

### Answer intake (security)
- Only comments whose `author_id` equals the configured **owner** (`ownerUid`) are delivered. Foreign, bot and missing authors are rejected. Max 4 KB per comment. Edits/deletes ignored.
- **Mapping:** reply in a question's comment thread → that question. Top-level comment starting `Q3` (optionally `Q3 2` = option 2) → that question. Any other comment → general message “[Knot message from user]”; if exactly one question is open it is delivered as “interpreted as answer to Q3 (<question>)” so the model can push back. First answer wins; question moves to the log as 👤.
- **Exactly-once:** a watermark (newest delivered comment `id` + `created_at`) is persisted via `appendEntry`; baseline set at page creation. Advance the watermark, then send; roll back only if `sendUserMessage` throws. All Knot I/O runs in one serialized loop.
- **Delivery:** always `pi.sendUserMessage(text,{deliverAs:"steer"})`; everything from one poll is batched into one message; never `expandPromptTemplates`. If the head is inside a long foreground `subagent` call, steer waits: page shows “answer received, queued”.
- Unsolicited comments are delivered even when idle (the headless feature).

### Lifecycle
- **Creation:** lazy — first subagent launch, first `knot_ask`, or `/knot on`. Title `<folder> · <speaking name>` (session name, else first prompt ≤6 words, redacted).
- **Timers:** started only in `session_start`, cleared in idempotent `session_shutdown`; handle also on a `globalThis` symbol and cleared at start (reload safety).
- **Session events:** `reload` → keep page, continue. `new`/`resume`/`fork` → old session's page ends; on `fork` drop the inherited page id (new page on demand); `resume` reuses the session's page.
- **Subagent state:** one RPC `status` read at `session_start`, then on `subagent:*` events (coalesced 250 ms) plus a slow safety read on the poll tick. Top-level children shown; nested fan-out as a count.
- **Model switch hint:** on `model_select` the page logs a 🔄 entry (“model switched to X; page keeps writing with <provider> token”) and the head line shows the current model. The Knot token stays pinned to the page-creating provider.
- **Knot outage:** exponential backoff, `ctx.ui.setStatus("knot: offline")`, never blocks or throws.

### Decision logging backstops
The extension itself logs what it sees: subagent launches (agent, model, label), model switches, user answers, timeouts. If a run used edit/write/bash but logged zero model decisions, the page shows “⚠ run ended with no logged decisions”. Section is titled “Decisions reported”.

### Making every future session use it
1. Global extension → status needs no model cooperation.
2. `knot_ask` description + `promptGuidelines` (severity rules, “alone in its batch”).
3. `AGENTS.md` section “Headless reporting via Knot”: *if `knot_ask` is available*, log every non-trivial decision, `critical` for hard/irreversible; never write Knot pages yourself.
4. Memory file `core/knot-report.md`; delegation-playbook line for children/replyTo.

### Testing
- Reducer tests (events → state) on recorded fixtures: duplicate/out-of-order `child-status`, `jobs-changed` bursts, foreground partials, workflow children, initial read.
- `render.ts` snapshots (running, idle, ended, blocked, 0 and 20 agents, long text) + same state ⇒ same markdown + bounded size; escaping of `- [x]`, `#`, `|`.
- Lifecycle: reload leaves one interval; `reason:"reload"` never ends the page; fork drops the page id; resume reuses it.
- Delivery: no re-delivery after reload; one batched send; throwing send rolls back the watermark; send always carries `deliverAs`; `/reload` in a comment is not executed; comments posted while pi was down delivered once.
- Security: foreign/bot/no author rejected; fake secret env values never reach page/title; thread-reply and `Q3` mapping.
- Guards: `PI_SUBAGENT_CHILD=1`, runner pid, print mode ⇒ inert.
- Knot client behind a fake: 401/5xx/timeout back off, never throw.
- Live smoke on a scratch subpage (cleanup manual): create → rewrite → comment → thread reply delivered; two sessions in one folder; **before building** run (a) idle `deliverAs:"steer"` wakes a turn, (b) ~500 replaces → check document size/UI.

## Left to the builder
Palette, exact emoji/wording, debounce numbers, snapshot tooling, internal file layout.

## My calls (user to confirm, beyond what they decided)
1. Severity policy: minor no wait; normal 2 h then default; critical indefinite.
2. Non-blocking `knot_ask` + question comments with thread replies.
3. Lazy page creation; “ended” only on quit; manual cleanup.
4. Speaking name from session name / first prompt (no LLM).
5. Page token pinned to the creating model's provider; 🔄 hint on model switch.

## Follow-up to raise with the user at the end
**Approach C** — optional LLM summarizer / nicer speaking names?

## Review round (2026-11-21, Opus-5-5 code + security reviewers) — what changed after v0.1.0 was first built
- Foreground/background rows now come only from pi-subagents' fleet status (`subagent` is async by default; the fleet already includes foreground children). The synthetic foreground rows were removed; the Task column uses `goal ?? role`.
- A fleet read is scheduled on `subagent` tool start/end and on every poll; `async-complete` turns done rows into failed; a truncated fleet (`omitted > 0`) no longer marks unseen rows done; the table shows the newest 20 rows.
- Timeouts of `normal` questions no longer depend on Knot (they run first in every tick, also when Knot is down, rejected the token, or `/knot off`).
- `knot_ask` failure undoes only its own question (persisted); `knot_ask` fails fast when Knot is offline; every request has a 10 s timeout and `redirect:"error"`.
- After `session_shutdown` an instance is dead (stopped flag, event listeners removed); the tool is registered in `session_start` only when reporting is active.
- Model-authored text (options, recommended, why) is quoted in every message sent back as the user; question comments are defanged and capped at 3500 bytes; PEM blocks, AWS/Slack/Google keys are redacted; bare URLs and @mentions are escaped.
- Comment timestamps are compared with padded fractions; resolved threads are included (`?include_resolved=true`); `agent_start` no longer resets run counters (`agent_settled` does).
- Declined: removing the token from `process.env` (the user's own agents use those variables from bash). Documented as residual risk.
- Not built in v0.1.0: cost/outcome on the ended page, nested fan-out count, "answer received, queued" marker, subagent launches logged as decisions, `error.log`.
