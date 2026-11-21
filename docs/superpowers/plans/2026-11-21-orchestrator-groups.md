# Orchestrator groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Knot page, show each pi-subagents workflow as a numbered "Orchestrator N" with its own table of workers; directly launched subagents go in a separate "Direct subagents" table.

**Architecture:** A new pure module `orchestrators.ts` reads the `asyncSnapshot` tree (workflow run nodes → worker step nodes), reduces it into `State.orchestrators` + tagged `AgentRow`s, and decides which fleet rows duplicate a worker. `render.ts` prints groups (running + last finished expanded, older finished one line). `extension.ts` feeds it from the existing fleet read and from the `subagent` launch arguments (task text).

**Tech Stack:** TypeScript, `node --test` (type stripping, no build), no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-21-orchestrator-groups-design.md` (approved by the user as Knot Q1).

## Global Constraints
- Name is exactly **Orchestrator**; workers table columns exactly `| | Worker | Model | State | Task |`; direct table heading `### Direct subagents` with columns `| | Agent | Model | State | Task |`.
- Expanded = every `running` orchestrator + the highest-`n` non-running one; every other orchestrator is one bullet line.
- Section heading stays `## 🤖 Agents`. With no orchestrators the output is byte-identical to today (single flat table, no sub-headings).
- All page text goes through `redact` first, then `esc`/cut (existing `e()` helper); task text shown cut to 80 chars.
- Output stays bounded: existing `MAX_ROWS = 30` (state) and `MAX_AGENTS = 20` (render) keep applying; at most 12 orchestrators are kept in state.
- No new dependency; tabs for indentation; smallest diff; do not touch files outside the task's list.
- **No git commits during execution.** The working tree already holds the user's uncommitted security fixes; the user commits. Replace "commit" with "`git diff --stat` shows only this task's files".
- Spec clarification: launch task texts wait in a memory-only queue (`Launch[]`, never persisted). Once a text is attached to a worker it lives in `AgentRow.task`, exactly like every task text today; restore already resets `agents`, so nothing is reloaded.

## Review Focus
1. Snapshot missing, `runs` not an array, or garbled nodes → section renders exactly as today, no throw. (Task 1, Task 3)
2. Two workflows both use worker keys `task-1…`; a script workflow (no `tasks` in its args) launched before a parallel one → no row gets another workflow's task text. (Task 1)
3. Hostile text in task/agent/model (`|`, newlines, `## h`, `- [x]`, a configured secret) in the new tables and headers → escaped and redacted. (Task 2)
4. Snapshot truncation (`omitted.runs > 0`, per-node child cap hit) → a running orchestrator is not wrongly marked done; `_+ more workers not shown_` appears. (Task 1, Task 2)
5. Three workers with the same agent+model start together → each claimed once, none duplicated under Direct; a direct subagent of the same agent+model started > 60 s earlier is not claimed. (Task 1)

---

## File Structure
- Create `extensions/knot-headless/orchestrators.ts` — pure: snapshot reading, fleet-row claiming, launch queue, state reducer. Create `orchestrators.test.ts`.
- Modify `core.ts` — types only (`Orchestrator`, `AgentRow.orch`, `State.orchestrators`, `State.nextOrch`).
- Modify `render.ts` (+ `render.test.ts`) — Agents section.
- Modify `extension.ts` (+ `extension.test.ts`) — wiring.
- README/CHANGELOG/screenshots in Task 4 (done by the main agent, not a writer).

### Task 1: `orchestrators.ts` + types

**Files:**
- Modify: `extensions/knot-headless/core.ts` (types only, near `AgentRow` / `State`)
- Create: `extensions/knot-headless/orchestrators.ts`, `extensions/knot-headless/orchestrators.test.ts`

**Interfaces:**
- Produces (core.ts): `export interface Orchestrator { id: string; n: number; state: "running" | "done" | "failed"; workers: number; startedAt?: number; endedAt?: number; truncated?: boolean }`; `AgentRow.orch?: string`; `State.orchestrators?: Orchestrator[]`; `State.nextOrch?: number`.
- Produces (orchestrators.ts):
  - `export interface SnapWorker { key: string; label: string; agent: string; model: string; state: AgentRow["state"]; startedAt?: number; nested: number; nestedTruncated: boolean }`
  - `export interface SnapOrch { id: string; state: Orchestrator["state"]; startedAt?: number; endedAt?: number; truncated: boolean; workers: SnapWorker[] }`
  - `export interface Launch { at: number; tasks: string[] }`
  - `export function mapSnapState(v: unknown): AgentRow["state"]` — `running→working`, `queued→waiting`, `complete→done`, `paused→paused`, `failed|partial|stopped|rejected→failed`, anything else `idle`.
  - `export function orchestratorsFromSnapshot(snapshot: any): SnapOrch[] | undefined` — `undefined` when `snapshot?.runs` is not an array; otherwise one entry per top-level run node with `kind === "workflow"`. Orchestrator state: `queued|running|paused→running`, `complete→done`, everything else → `failed`. Workers = children with `kind === "step"` and a string `agent`; `key = id`, `model = model ?? ""`, `nested` = number of descendants (any depth) that have an `agent`, `nestedTruncated = children.length >= cap` with `cap = snapshot.caps?.maxChildrenPerNode ?? 8`; orchestrator `truncated = node.children.length >= cap`.
  - `export function claimWorkerEntries(entries: any[], orchs: SnapOrch[]): Set<string>` — keys of fleet entries that duplicate a worker: for each worker in order, claim the unclaimed entry with equal `agent` and equal `String(model ?? "")` whose `|startedAt − worker.startedAt|` is smallest and ≤ 60 000 ms (a missing startedAt on either side counts as distance 0).
  - `export function launchFromArgs(args: any, now: number): Launch | undefined` — `undefined` unless `args.workflow` is truthy and `args.action` is absent; `tasks = Array.isArray(args.args?.tasks) ? args.args.tasks.map((t) => String(t?.task ?? "")) : []`.
  - `export function addLaunch(list: Launch[], l: Launch, now: number): Launch[]` — drops records older than 10 min, appends, keeps the newest 16.
  - `export function applyOrchestrators(s: State, snap: SnapOrch[], o: { launches: Launch[]; now: number; omitted: boolean }): { state: State; launches: Launch[] }` — rules below.

`applyOrchestrators` rules: (a) process `snap` sorted by `startedAt` ascending (missing last); (b) an unseen `id` gets `n = s.nextOrch ?? 1`, `nextOrch` increments (numbers are never reused); (c) for a new orchestrator take the oldest launch with `tasks.length === workers.length` (or `>=` when `truncated`) and `tasks.length > 0`, remove it from the returned `launches`, and give worker `task-N` the text `tasks[N-1]` (whitespace collapsed, trimmed, cut to 200); (d) worker rows are rebuilt on every call with `key = "${id}:${worker.key}"`, `name = agent`, `model`, `state`, `orch = id`, `nested`/`nestedTruncated` only when `nested > 0`, `task = newText ?? previous row's task ?? worker.label`; (e) existing orchestrators absent from `snap` and `running` become `done` with `endedAt = now` and their `working` rows become `done`, unless `o.omitted` (then untouched); (f) keep the 12 highest-`n` orchestrators and drop rows whose `orch` was dropped; (g) rows without `orch` are never touched.

- [ ] **Step 1: Write the failing tests** in `orchestrators.test.ts` (fixtures: `step(id, agent, model, state, extra?)` → `{ id, kind: "step", label: id, state, agent, model, startedAt: 1_000, ...extra }`; `wf(id, children, extra?)` → `{ id, kind: "workflow", label: "x", state: "running", startedAt: 1_000, children, ...extra }`; `snap(runs, extra?)` → `{ omitted: { runs: 0, children: 0, byteLimitExceeded: false }, caps: { maxChildrenPerNode: 8 }, runs, ...extra }`). Tests, each with the assertions named:
  - `mapSnapState table`: the seven mappings above.
  - `orchestratorsFromSnapshot: undefined for garbage, [] without workflow nodes`: `undefined`, `{}`, `{runs:"x"}` → `undefined`; `snap([])` and `snap([{ id:"s", kind:"subagent", label:"a", state:"running" }])` → `[]`.
  - `orchestratorsFromSnapshot maps workers`: workflow with `step("task-1","backend-developer","glm-5.3","complete")`, `step("task-2","x","m","queued")`, one step with nested children (2 descendants having `agent`) → keys, `state` done/waiting, `nested` 2, `truncated` false; `caps.maxChildrenPerNode = 2` with two children → `truncated` true.
  - `claimWorkerEntries`: 3 fleet entries same agent/model + 2 workers → exactly 2 keys claimed, the third not; an entry with `startedAt` 5 min away is not claimed; an entry with another model is not claimed.
  - `applyOrchestrators first sight`: number 1, `nextOrch` 2, row key `"o1:task-1"`, task from a launch with 2 tasks when the workflow has 2 workers; that launch is removed from the returned list; a launch with `tasks: []` is not consumed and a row without text falls back to `"task-1"`.
  - `applyOrchestrators key collision`: launches `[2 tasks, 3 tasks]`, orchestrator X (3 workers, started 2 000) and Y (2 workers, started 1 000), all keyed `task-1…` → rows of X carry the 3-task texts, rows of Y the 2-task texts, all row keys distinct.
  - `applyOrchestrators later reads`: same snapshot again keeps `n`, keeps task texts; vanished running orchestrator → `done`, `endedAt = now`, working rows `done`; with `omitted: true` it stays `running`; a direct row (no `orch`) is unchanged.
  - `applyOrchestrators cap`: 13 distinct orchestrators → 12 kept, `n = 1` dropped with its rows, `nextOrch` 14.
  - `launchFromArgs / addLaunch`: `{ workflow: "parallel", args: { tasks: [{agent:"a",task:"do x"},{agent:"b",task:"do y"}] } }` → `tasks ["do x","do y"]`; `{ workflow: true }` → `tasks []`; `{ agent:"x", task:"y" }` and `{ workflow:"p", action:"status" }` → `undefined`; a record older than 10 min is dropped and the list never exceeds 16.
- [ ] **Step 2: Run** `node --test extensions/knot-headless/orchestrators.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the core.ts types and `orchestrators.ts` per the Interfaces and rules above (pure functions, no I/O; import types from `./core.ts`).
- [ ] **Step 4: Run** `node --test extensions/knot-headless/orchestrators.test.ts extensions/knot-headless/core.test.ts extensions/knot-headless/outcome.test.ts` — Expected: all PASS.
- [ ] **Step 5:** `git diff --stat` shows only `core.ts`, `orchestrators.ts`, `orchestrators.test.ts`.

### Task 2: Render the groups

**Files:**
- Modify: `extensions/knot-headless/render.ts` (the `## 🤖 Agents` block in `render`), `extensions/knot-headless/render.test.ts`

**Interfaces:**
- Consumes: `State.orchestrators`, `AgentRow.orch`, `Orchestrator` (Task 1; the types may be added by Task 1 in parallel — rely on the signatures above).
- Produces: unchanged `render(s, o)`; no new exports required. Extract the existing row formatting into an internal helper used by all tables.

Output contract (exact strings):
- Expanded header: `### 🎛 Orchestrator ${n} · ${label} · ${workers} worker(s)` with `label` = `▶ running` | `✅ done` | `❌ failed`, `1 worker` / `N workers`; followed by a blank line and the worker table (rows = `s.agents` with `orch === id`, same cells as today, newest 20 with the existing `_+N older not shown_` line); if `truncated`: `_+ more workers not shown_`.
- Collapsed: `- ${✅|❌} Orchestrator ${n} · ${workers} worker(s) · ${m} min` (`m = max(0, round((endedAt − startedAt)/60000))`; omit ` · ${m} min` when either timestamp is missing). Collapsed bullets come first (ascending `n`), then expanded sections (ascending `n`), then `### Direct subagents` (rows without `orch`; omitted when there are none).

- [ ] **Step 1: Write the failing tests** in `render.test.ts` (use the existing `base()`/`agent()` helpers, extended with `orch`):
  - `no orchestrators → no group headings`: `!out.includes("### 🎛")` and `!out.includes("### Direct subagents")` for a state with plain agents; existing tests keep passing unchanged.
  - `one running orchestrator + one direct row`: contains `### 🎛 Orchestrator 1 · ▶ running · 2 workers`, `| | Worker | Model | State | Task |`, `### Direct subagents`; the direct row is under `### Direct subagents`, the workers above it.
  - `collapse rule`: orchestrators 1 (done, 3 workers, 4 min), 2 (done), 3 (running), 4 (done) → `### 🎛 Orchestrator 3` and `### 🎛 Orchestrator 4` present, `- ✅ Orchestrator 1 · 3 workers · 4 min` and `- ✅ Orchestrator 2` present, no `### 🎛 Orchestrator 1`, and a worker row belonging to 1 is not in the output.
  - `failed + truncated`: `❌ failed` in a header and `_+ more workers not shown_` after the table.
  - `hostile text`: worker task `- [x] Q1\n## evil | pipe` and a configured secret in agent/task → no line matching `/^\s*- \[[ x]\]/m`, no `^#{1,6} evil`, secret absent, `redacted` present.
  - `bounded`: 12 orchestrators (11 done, 1 running), 30 rows total with 500-char tasks → `out.length < 8192`.
- [ ] **Step 2: Run** `node --test extensions/knot-headless/render.test.ts` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the Agents block in `render.ts` per the contract; when `!s.orchestrators?.length` keep the current output path untouched.
- [ ] **Step 4: Run** `node --test extensions/knot-headless/render.test.ts extensions/knot-headless/outcome.test.ts extensions/knot-headless/summary.test.ts` — Expected: all PASS.
- [ ] **Step 5:** `git diff --stat` shows only `render.ts`, `render.test.ts` (plus Task 1's files if run in parallel).

### Task 3: Wire it into the extension

**Files:**
- Modify: `extensions/knot-headless/extension.ts` (`applyFleet`, `readFleet`, the `tool_execution_start` handler, `session_start` restore), `extensions/knot-headless/extension.test.ts`

**Interfaces:**
- Consumes: from `orchestrators.ts`: `orchestratorsFromSnapshot`, `claimWorkerEntries`, `applyOrchestrators`, `launchFromArgs`, `addLaunch`, `type Launch` (Task 1).
- Produces: runtime behaviour only.

Behaviour: (a) module-local `let launches: Launch[] = []`, reset on every `session_start`; in `tool_execution_start` for `subagent` push `launchFromArgs(event.args, deps.now())` when defined. (b) `applyFleet`: `snap = orchestratorsFromSnapshot(snapshot)`; if `snap?.length`, `claimed = claimWorkerEntries(entries, snap)` and the direct entries are those not claimed and not named `workflow`; otherwise all entries (today's behaviour). The existing live/carried logic runs only on direct rows (`!a.orch`); then `applyOrchestrators(st, snap, { launches, now: deps.now(), omitted: Number(snapshot?.omitted?.runs ?? 0) > 0 })` when `snap` is defined (an empty `snap` still lets vanished orchestrators finish); store the returned `launches`. Keep the `MAX_ROWS` slice over all rows. (c) restore: `orchestrators: []` and keep `nextOrch`, together with the existing `agents: []` reset.

- [ ] **Step 1: Write the failing tests** in `extension.test.ts` (drive with `h.fleet` / `h.snapshot` like the test `nested count from the status snapshot lands on the matching row…`; launch via the tool event helper the neighbouring subagent tests use):
  - `a workflow becomes an Orchestrator with its workers`: fleet has one entry `{ key:"w", agent:"workflow" }` and 2 worker entries (same agent/model, `startedAt` equal to the snapshot's); snapshot has a workflow node with those 2 steps → `h.handle.state().orchestrators` has one entry `n: 1`, 2 agent rows with `orch` set, no row named `workflow`, no unclaimed duplicates; rendered page contains `### 🎛 Orchestrator 1`.
  - `task text comes from the launch arguments`: before the first read, fire `tool_execution_start` for `subagent` with `{ workflow: "parallel", args: { tasks: [{agent:"a",task:"fix the parser"},{agent:"b",task:"write tests"}] } }` → worker rows' `task` are `fix the parser` / `write tests`.
  - `two workflows with the same task-N keys keep their own rows`: two snapshot workflow nodes → two orchestrators `n` 1 and 2, 4 distinct row keys.
  - `without a snapshot nothing changes`: `h.snapshot = undefined` with a `workflow` fleet entry → one flat row named `workflow`, `orchestrators` undefined.
  - `a finished orchestrator stays on the page`: next read with an empty fleet and an empty `snap` → orchestrator `done`, rows `done`.
  - `restore resets orchestrators but numbering continues`: save state with 2 orchestrators, resume → `orchestrators` `[]`, `nextOrch` 3.
- [ ] **Step 2: Run** `node --test extensions/knot-headless/extension.test.ts` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** per the Behaviour block.
- [ ] **Step 4: Run** `npm test` — Expected: all PASS (whole suite).
- [ ] **Step 5:** `git diff --stat` shows only `extension.ts`, `extension.test.ts` (plus the other tasks' files).

### Task 4: Docs, screenshots, live check (main agent)

**Files:**
- Modify: `README.md` (feature bullet, screenshot caption), `CHANGELOG.md`, `docs/design-v0.2.md` or a new `docs/design-v0.3.md` note, `docs/images/*.png`; local only (gitignored): `scripts/preview.ts` fixtures.

- [ ] **Step 1:** Add orchestrator fixtures to `scripts/preview.ts` (running page: Orchestrator 2 running with 3 workers + one finished collapsed line + a Direct subagent; ended page likewise), regenerate the three PNGs as before, read them to confirm.
- [ ] **Step 2: Live check** with a real `pi --mode rpc` session (model `ollama-cloud/glm-5.3-flash`): launch a 2-task `parallel` workflow, read the page via `GET /api/docs/{id}/markdown`. Expected: one `### 🎛 Orchestrator 1` with two workers carrying their task text, no `workflow` row, no worker duplicated under Direct. Archive the test page afterwards (`DELETE /api/docs/{id}`). If workers are duplicated, widen/adjust `claimWorkerEntries` and re-run Task 1 tests.
- [ ] **Step 3:** README feature line + CHANGELOG entry; `npm test`, `bash scripts/scan.sh --history` both clean.

## Self-Review (done)
- Spec coverage: grouping/naming/numbering (T1,T2), separate tables + Direct (T2), collapse rule (T2), task text from launch args (T1,T3), no-snapshot fallback (T1,T3), bounded size (T2), restore reset (T3), live verification of the join (T4). Gap check: "outcome line unchanged" needs no task (rows stay in `agents`).
- Types consistent: `Orchestrator`, `SnapOrch`, `SnapWorker`, `Launch`, `applyOrchestrators` signatures used identically in T1/T3.
- Proportion: plan is a few times the spec's size because it fixes signatures and test names; no function bodies are given except rules the signature cannot express.
