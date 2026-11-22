# Quiet comments and an always-current last message (design, small change)

Status: revision 2 (reviewed by claude-opus-5-5 high, findings applied), 2026-11-22. Size: small (two independent parts, one commit each).

## Why

The user drives long sessions from Knot. Two problems:

1. The page's comment list piles up (one question comment per `knot_ask`, plus every reply and general comment) and gets unreadable.
2. A Knot-only user cannot see what the model said in the CLI. They must know from the page alone whether something is due or the task finished. Today the last message is shown only while idle, and only if a page already exists or the message looks like a question.

Goals: a short comment list; the last CLI message always visible and independent of the CLI; nothing lost when a comment is cleaned.
Non-goals: message history on the page (only the last one lives); deleting comments; showing pi's own tool-approval/dialog prompts (not observable by extensions yet, stated in README and on the page); changing how answers are delivered; a new setting.
Anti-goal: cleaning a comment the session has not received yet.

## Approaches

- **Resolve old threads (chosen by the user, Q4).** Reversible, hides threads in the Knot UI, no dependence on delete permission.
- Delete old threads: final, may be refused for the user's comments. Rejected.
- Resolve first, delete later: extra rule nobody asked for. Rejected.

## Spike results (2026-11-22, scratch pages, archived afterwards)

- `POST /api/docs/{id}/comments/{rootCommentId}/resolve` → 204. Hides the **whole thread** (root and replies) from the default list; `GET ...?include_resolved=true` (what the extension uses, `knot.ts:92`) still returns all of it; the root carries `resolved_at`.
- The id must be the **root** comment id (= `thread_id`). Resolving an already resolved thread → 404 `thread not found or not a root`: treat as done.
- A reply posted into a resolved thread → 201, the thread stays resolved, and the reply is returned by `include_resolved=true`: late answers are still delivered.
- `DELETE .../comments/{id}` → 204 on the bot's own comment (not used).
- **Not verified:** whether the bot may resolve a thread rooted in the *owner's* comment (a general top-level comment). Handled by treating every resolve failure as local (below); verified in the live check.

## Part 1: comment cleanup

Own step, **not inside `pollComments`** (that returns early when there is nothing fresh, when self-owned, stopped or ended): `pollComments` hands back the list it fetched, and `tickInner` runs `cleanupThreads(all)` after `writePage`, on every poll.

- **Done thread:** no comment of it is in `newComments(all, st.watermark)` (same ordering as delivery, `core.ts:250`), the watermark being the committed one (after a successful send, never the rolled-back `run` value), and it is not the thread of an open question (`q.threadId`, includes mirrored ones). Root not yet resolved (`resolved_at` null).
- **Keep newest 5:** rank all threads by their latest activity (newest `created_at` of any comment in the thread, so a just-answered old question thread stays visible), keep the first 5 whatever their state, resolve the done ones below that, **at most 3 per poll**.
- **Skipped** when `selfOwned`, stopped, ended, or inactive.
- **Errors are local to the cleanup step.** `knot.ts` gets a `resolveThread(pageId, rootId)` that makes **one attempt, no retry/backoff** and returns `"ok" | "gone" | "refused"` (204 / 404 / any other HTTP error incl. 401/403/429/5xx; implemented with an error that carries the status, not by matching message text). A `"refused"` stops the batch for this poll and remembers the root id in an in-memory set so it is not retried within the process. Nothing from cleanup reaches `knotFailed`, so it can never disable reporting or skip the page write; real auth problems surface on the next list/replace.
- **Nothing is lost:** answers already appear as `Q3 text → answer` under *Decisions reported*; resolved threads stay retrievable ("show resolved" in Knot). General comments are **not** logged under Decisions (dropped from rev 1: it needs a new `by` value, would push model decisions out of the 8 shown, and resolving is reversible).
- Known limits, stated in README: resolving does not shrink what the extension downloads (the 2 MiB list cap still applies on extremely long pages); a comment that surfaces late with an older timestamp is already skipped by delivery today and would now also be hidden.

## Part 2: last message, always

- **`message_end` is the only place that sets `state.lastMessage`** (`agent_settled` no longer does; it only does the chat-question mirroring). Set for every assistant message with text, also while running, stored **already redacted** (`clean()` before any cut) and **already elided** (over 1400 chars: head 600 + `…` + tail 800). Aborted/error messages are shown too (it is what the CLI printed). In memory only: persisted by the existing `persist()` at `agent_settled`, not at every message (a tool-heavy run has hundreds of assistant messages and each save is a full state snapshot).
- Never cleared at `agent_start` (the time next to it shows its age).
- **Page creation:** the first assistant message of a session creates the page when reporting is active (the user wants Knot to work alone; this replaces lazy creation for TUI/RPC sessions, which `docs/design.md:93,125` recorded as the earlier decision, so those lines and the README get updated). No new setting; revisit if the page-per-session clutter bothers. `message_end` calls `launchTrigger()` **only when `!st.pageId && active()`**; otherwise it only updates memory and the 15 s write throttle plus the 20 s tick publish it (no forced write per message). Inert paths (subagent children, print/json mode, `/knot off`, reporting off) make zero Knot calls.
- **Section** `## 💬 Last message from the agent · HH:MM`, shown in every phase including ended, after *Needs you*. Rendered line by line as a blockquote by a new `escLines`: each line gets today's `esc` rules (redaction, defang, no HTML/pipes) without collapsing whitespace across lines, line-start markers that would break the quote or fake structure (`---`, `===`, `#`, `1.`, `-`, `+`, `*`, 4-space indents) are neutralised, runs of blank lines collapse to one, and the raw cap is applied before escaping.
- One italic footnote under it: pi's tool approvals and dialogs are not visible here; an action is due only if the message or an open question says so.
- Freshness: a running update normally shows within one 20 s tick (throttle 15 s); slower while Knot retries. Stated in README.
- Unchanged: an ask-looking message at `agent_settled` becomes a mirrored critical question; the 0.2.2 drop rules stay.

## Tests (tests-first)

Existing tests that must change: `extension.test.ts:1144` (message cleared after `agent_start`), `:1154` and `render.test.ts:340` (old heading), `render.test.ts:345` (nothing shown while running), `extension.test.ts:1186` (no page after a plain message); `docs/design.md:66`.

New:
- Cleanup: done-thread selection (newest 5 by latest activity kept, undelivered root/reply never, open and mirrored question threads never, bot- and owner-rooted), max 3 per poll, runs on a poll with no fresh comments, no resolve after a rolled-back failed delivery, self-owned/ended: none; `FakeKnot` gets `resolveThread` with `resolved_at` and "reply into resolved thread still delivered".
- Errors: refused/500/429 on resolve leaves reporting enabled, status not offline, page still written in the same tick; one attempt only; refused id not retried; 404 counts as done.
- Last message: shown in every phase incl. ended; replaced by the next one; survives resume; N `message_end` events cause at most one forced write and no persist per message; a newer message shows after a clock jump past the write gap on a normal tick (not `tick(true)`); page created on the first message; print mode, `/knot off` and child sessions with `message_end` make zero Knot calls.
- Render: secret at the elision cut redacted; line-start injection lines (`---`, `===`, `# x`, `1. x`, `- x`, indented) neutralised; line breaks kept; footnote present.

## Left to the builder

Constant names, exact elision marker, README/CHANGELOG wording. Live check on a real session page before release, including: resolving a thread rooted in the owner's comment, a late reply into a resolved thread. No push or release without the user's say-so.
