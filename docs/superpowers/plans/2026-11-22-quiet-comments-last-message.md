# Quiet comments and always-current last message Implementation Plan

> **For agentic workers:** execute task by task, tests first. Steps use checkbox syntax.

**Goal:** Resolve old finished comment threads on the Knot page and always show the model's latest CLI message on it.

**Architecture:** Part 1 adds a one-attempt `resolveThread` to the Knot client, a pure `pickResolvable` in `core.ts` and a `cleanupThreads` step in `tickInner` after the page write. Part 2 makes `message_end` the only writer of `state.lastMessage` (redacted, elided, in memory), creates the page on the first message, and renders the section in every phase with a line-wise escape.

**Tech Stack:** TypeScript run by `node --test` (no build). Tests: `npm test` in the repo root.

**Spec:** `docs/superpowers/specs/2026-11-22-quiet-comments-last-message-design.md` (revision 2, approved in Q6).

## Global Constraints

- Keep newest **5** threads (by latest activity), resolve at most **3** per poll, **one attempt** per resolve, no retries.
- Elide a last message over **1400** chars as head **600** + `…` + tail **800**, after redaction.
- Heading text is exactly `## 💬 Last message from the agent · HH:MM`.
- No new setting, no push, no release. One commit per part. Never print or store tokens.

## Review Focus

- Resolve refused (403) / 500 / 429 / network error: reporting stays enabled, page still written in the same tick (Task 2).
- Rolled-back delivery must not lead to resolving undelivered threads (Task 2).
- A just-answered old question thread stays unresolved (Task 2).
- Secret at the elision cut; markdown line-start injection in the message (Task 3).
- Inert modes (print, `/knot off`) make zero Knot calls on `message_end` (Task 3).

---

### Task 1: Knot client `resolveThread`

**Files:** Modify `extensions/knot-headless/knot.ts`, `fakepi.ts`; Test `knot.test.ts`.

**Interfaces:**
- Produces: `Comment.resolved_at?: string | null`; `Knot.resolveThread(pageId: string, rootId: string): Promise<"ok" | "gone" | "refused">`; `FakeKnot.resolveThread` (records ids in `resolved: string[]`, sets `resolved_at` on the root, can fail via `failResolve?: "refused" | Error`), and FakeKnot comment `resolved_at: null` by default.

- [ ] Write failing tests in `knot.test.ts`: 204 → `"ok"`; 404 → `"gone"`; 403, 429 and 500 → `"refused"` with **exactly one** fetch call and no sleep; URL is `POST /api/docs/{id}/comments/{rootId}/resolve`; invalid page id throws; network error throws a plain `Error` (not `KnotAuthError`).
- [ ] Run `npm test`, confirm they fail.
- [ ] `call(..., once?: boolean)`: when `once`, return the response as is after the first attempt (any status), throw a plain `Error` on network failure; implement `resolveThread` on top (`assertPageId` first).
- [ ] Run `npm test`, confirm pass. (Commit together with Task 2.)

### Task 2: Cleanup step (commit 1)

**Files:** Modify `core.ts`, `extension.ts`; Test `core.test.ts`, `extension.test.ts`; Add the spec and this plan to the commit.

**Interfaces:**
- Consumes: `newComments`, `Comment`, `Knot.resolveThread`.
- Produces: `pickResolvable(all: Comment[], wm: {id: string; createdAt: string}, openThreadIds: string[], skip: ReadonlySet<string>, keep = 5, max = 3): string[]` returning root ids to resolve; `pollComments(): Promise<Comment[] | undefined>` (the fetched list, `undefined` when it returned early); `cleanupThreads(all)` inside `create()`.

- [ ] Tests for `pickResolvable` (core.test.ts): newest 5 threads by latest activity kept even when done; older thread with every comment at/below the watermark picked, oldest first, max 3; thread with a comment above the watermark never; thread whose id is in `openThreadIds` never; root with `resolved_at` never; id in `skip` never; a thread whose root is old but a reply is new counts as new activity (kept).
- [ ] Tests in extension.test.ts: cleanup runs on a poll with no fresh comments; not after a failed delivery that rolled back (use `h.sendThrows`); not when `selfOwned`, nor on an ended page; refused (`failResolve: "refused"`) / thrown error: reporting stays active, status not `knot: offline`/`disabled`, page still replaced in the same tick, the refused id not retried on the next poll; a reply into a resolved thread is still delivered; just-answered old question thread not resolved.
- [ ] Run `npm test`, confirm they fail.
- [ ] Implement `pickResolvable` (group by `thread_id`, root = comment with `parent_id` null; activity = newest `normTs(created_at)` in the thread; sort threads by activity desc; skip the first `keep`; then candidates oldest first filtered by the rules above; `slice(0, max)`).
- [ ] `pollComments` returns `all` (undefined on its early returns); `tickInner` keeps it in `listed`, after `writePage(force)` runs `cleanupThreads(listed)` in its own try/catch (errors logged only, never `knotFailed`). `cleanupThreads`: skip if `selfOwned`, `stopped`, ended; use `st.watermark` and `st.questions.flatMap(q => q.threadId ?? [])`; per id call `knot.resolveThread`; on `"refused"` or a thrown error add to the in-memory refused set (thrown: just log) and stop the batch.
- [ ] Run `npm test`, confirm pass; commit `feat: resolve finished comment threads so the page stays short` with the `Co-authored-by: pi.dev <pidotdev@proton.me>` trailer.

### Task 3: Last message always (commit 2)

**Files:** Modify `core.ts` (`elide`), `render.ts` (`escLines`, section), `extension.ts`, `README.md`, `CHANGELOG.md`, `docs/design.md`; Test `core.test.ts`, `render.test.ts`, `extension.test.ts`.

**Interfaces:**
- Produces: `elide(text: string): string` (core.ts, the 600/800 rule); `escLines(text: string, secrets?: string[], max?: number): string[]` (render.ts, one escaped output line per input line, blank-line runs collapsed to one `""`, line-start `-`, `+`, `=` and `1.`/`1)` neutralised, indentation dropped, redacted before the cap).

- [ ] Change the existing tests named in the spec: `extension.test.ts` message cleared at `agent_start`, old heading, no page after a plain message; `render.test.ts` old heading and "nothing shown while running". Replace with the new expectations below.
- [ ] New tests: `elide` boundaries (1400 unchanged, 1401 elided); secret straddling the cut is redacted before eliding; `escLines` injection lines (`---`, `===`, `# x`, `1. x`, `- x`, `    indented`) and kept line breaks; section shown in running, idle and ended phases with time and footnote; `message_end` while running sets the message and a normal tick (clock past the write gap, not `tick(true)`) publishes it; N `message_end` events → at most one forced write and no `appendEntry` per message; first assistant message creates the page (no page before, one after, no creation when inactive); print mode, `/knot off` → zero Knot calls; survives resume; `agent_settled` does not overwrite it with the tail-only text and still mirrors an ask.
- [ ] Run `npm test`, confirm the new ones fail.
- [ ] `message_end` (assistant with text): `lastText = t`; `st.lastMessage = {text: elide(clean(t)), at: now}`; `if (!st.pageId && active()) void launchTrigger()`. `agent_start`: stop clearing `lastMessage`. `agent_settled`: no longer sets `lastMessage`; `if (active()) persist()`; ask mirroring unchanged; if `active() && (st.pageId || asks)` then `launchTrigger().then(() => handle.tick(true))`.
- [ ] `render.ts`: section after *Needs you* in every phase: heading, `escLines` lines as `> ` blockquote (empty line → `>`), footnote `_pi's tool approvals and dialogs are not visible here; something is due only if the message above or an open question says so._`.
- [ ] README (Limitations bullet, replace the idle-only wording; freshness ~20 s; resolve cleanup and its limits), CHANGELOG under Unreleased, `docs/design.md:66,93,125`.
- [ ] Run `npm test`, confirm pass; commit `feat: always show the agent's latest message on the page`.

## Self-review

Spec coverage: Part 1 → Tasks 1–2; Part 2 → Task 3; tests list → tasks; README/design updates → Task 3. Type names consistent (`resolveThread`, `pickResolvable`, `elide`, `escLines`). Live check (owner-rooted resolve, markdown blockquote lines in Knot) happens after the build, before any release.
