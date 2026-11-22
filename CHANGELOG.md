# Changelog

## [Unreleased]

- **A send into the session that keeps failing backs off.** When `sendUserMessage` throws (an answer, a comment or a timeout notice), the retry now waits 20 s, 40 s, 80 s ... up to 5 minutes instead of every poll, and each retry no longer writes a fresh state snapshot into the session file. The header shows `⚠ delivery to the session is failing (n attempts)` and pi's status line `knot: delivery failing (n)` until a send works. Comments stay undelivered (and unresolved) meanwhile.
- **Two sessions in one process no longer clobber each other.** The poll timer is kept per session id (a reload still replaces its own old timer) and pending subagent launches belong to their session. Before, starting a second session stopped the first one's polling.
- **`&` is escaped on the page** (Knot decodes entities, verified), so an entity such as `&#58;` can no longer rebuild a URL or mention the escaping had defanged.
- Tests for the 2 s cost-RPC timeout (no reply from pi-subagents, no leaked listener), the backoff (poll and timeout paths), per-session timers and launches.

- **Dialogs waiting in the terminal are on the page.** While a pi dialog (confirm, select, input, editor, custom screen) is open, the header says `waiting on you: the terminal (<title>)` and *Needs you* lists it with its kind and since when; it disappears when the dialog closes (pi's `ui_prompt_start`/`ui_prompt_end` events). It is written to the page at once, creates the page if there is none, and is never restored after a restart. It can only be answered in the pi terminal. The footnote under *Last message from the agent* is updated accordingly.

- **Less noise under *Decisions reported*.** The `⚠ run ended with no logged decisions` note now appears once per session instead of after nearly every run (its once-only flag was reset immediately), and a question copied from the chat no longer adds its own `mirrored as Qn` line (the question itself is the record).
- **Questions copied from the chat quote cleanly.** The quote is the last paragraph cut to whole sentences (a single overlong sentence is cut at a word boundary with an ellipsis), no longer the last 180 characters, which started mid-sentence.

- **A gear (⚙️) marks a running session** instead of ▶: in the page title, the header line, a working subagent and a running orchestrator. The same symbol everywhere; ▶ is a text glyph that some fonts draw plain and tiny.

- Screenshots in the README show the current page design (header state, session id line, last message code block, usage, summary).

- **The pi session id is on the page.** A line under the header shows `pi --session <id>` so the session behind a Knot page can always be reopened (run it from any directory).
- **The last message stands out.** *Last message from the agent* is now a fenced code block: it is boxed, nothing in it is interpreted as markdown (the fence is always longer than any backtick run in the text, so it cannot break out), line breaks are kept, and secrets are still redacted before the text is cut. Long lines scroll sideways.

## [0.2.3] - 2026-11-22

- **The page always shows the agent's latest CLI message** (*Last message from the agent · HH:MM*), in every phase including while the agent is running and after the session ended, so Knot alone is enough to see whether something is due or the task finished. It is set at every assistant message, replaced by the next (nothing piles up), redacted before long text is elided (first 600 + last 800 characters), and rendered line by line with markdown line-start markers neutralised. The first assistant message of every TUI/RPC session now creates the page (retried at most once per 20 s while Knot is down); it used to be created lazily. Not yet visible: pi's own tool-approval and dialog prompts (the page says so).

- **Old comment threads are resolved.** In long sessions the Knot comment list piled up. Once a thread is finished (every comment in it was delivered to the session, and it is not an open question) and it is not among the newest 5 threads (by latest activity), it is resolved, at most 3 per poll. Resolved threads are hidden in Knot but stay retrievable ("show resolved"), and a late reply into one is still delivered. Answers stay in *Decisions reported*. Best effort: one attempt per thread, a refusal or error never disables reporting or blocks the page write.

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
