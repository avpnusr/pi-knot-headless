# Orchestrator groups on the Agents section (short design)

Status: **approved by the user (Knot Q1, 2026-11-21) and implemented.** Size: small change (render + state + one snapshot reader + tests; no new dependency).

## Intent and why
On the Knot page the Agents section is hard to read: every scripted workflow shows up as a row literally named `workflow`, and the workers it started are separate, unrelated rows whose Task column is just `task-1`, `task-2`. You cannot tell which workflow started which worker. The user reads this on a phone, often after the fact.

Root cause (verified in `pi-subagents` source): the live fleet RPC (`rpc.js buildFleetStatus`) emits one entry `agent: "workflow"` (no model, no goal) per workflow job, and each worker as an ordinary entry with an opaque key and no parent link. Async entries never carry `goal`, so the Task column falls back to `role` = the step label. The parent/child link *does* exist in the tree snapshot (`asyncSnapshot.runs[]`, `async-status-projection.js`: workflow run node → step children with `id` = workflowKey, `agent`, `model`, `state`), which the extension already reads for the nested count.

## Goals
- A workflow is shown as an **Orchestrator** (the instance steering its workers), numbered per session: `Orchestrator 1`, `2`, …
- Each orchestrator has **its own table of workers** beneath a header line with its state.
- Subagents the head model launched directly stay in a separate **Direct subagents** table.
- The Task column shows what the worker was asked to do, not `task-1`.
- Long sessions stay short: **running orchestrators and the most recently finished one are expanded**; older finished ones collapse to one line.

## Non-goals
- No recursive tree of nested runs (the existing `+N nested` count stays).
- No workflow names/titles (pi-subagents does not expose one in the snapshot), no per-orchestrator cost, no change to the outcome/usage lines.
- Foreground subagents cannot be grouped (they are not in the snapshot); they appear under Direct subagents.

## Anti-goals
- The page must not get longer or heavier than today: the existing bounded-size render test (< 8 KB, 20 agent rows) still holds.
- No regression when `asyncSnapshot` is missing or has no workflow node: the Agents section renders exactly as today.

## Constraints
- Snapshot is bounded by pi-subagents: 8 children per node, depth 3, `omitted.children` says what was cut. Show `_+ more workers not shown_` when truncated.
- Only active/recent async runs are in the snapshot; a finished orchestrator is remembered from the last snapshot that contained it.
- Everything written to the page keeps going through `redact` then `esc`/cut (redact first); task text cut to 80 chars.

## Approaches
- **A (chosen): group from the tree snapshot.** Orchestrator = `kind:"workflow"` run node, workers = its `agent` step children; task text from the launch call arguments captured at `tool_execution_start`, keyed by step label (`task-N` for the `workflow:"parallel"` form), else the step label. Uses data we already read; no new RPC.
- B: keep the flat fleet table, add a "Started by" column. Smaller, but a wide table is poor on a phone and it is not the separate tables asked for.
- C: track only from launch arguments. Rejected: scripted workflows choose their children at runtime, so the arguments do not list them.

## Decisions (as discussed with the user, and my calls)
- User: name is **Orchestrator**; running + last finished expanded, older finished collapsed to one line.
- My calls:
  - Header: `### 🎛 Orchestrator 2 · ▶ running · 3 workers`; collapsed line: `- ✅ Orchestrator 1 · 3 workers · 4 min`.
  - Worker table columns: `| | Worker | Model | State | Task |` (same dot palette, same state glyphs as today).
  - Numbering: persisted counter, assigned when an orchestrator is first seen, never reused.
  - Snapshot state mapping: queued/running → ▶ running; complete → ✅ done; failed/partial/stopped/rejected → ❌ failed.
  - State: `AgentRow` gains `orch?: string` (orchestrator id); `State` gains `orchestrators?` (`{ id, n, state, startedAt, endedAt? }[]`) and `nextOrch?`. Restored sessions reset them like agents are reset today.
  - Fleet rows that match a snapshot worker (same agent + model + startedAt) are not repeated under Direct subagents.
  - Heading stays `## 🤖 Agents`; when there is no orchestrator the section is identical to today (single table, no sub-headings).
  - Launch task texts are kept in memory only (at most 64), never persisted.
  - Collapsed orchestrators drop their worker detail from the page; the ended outcome line still counts all subagents.

## Left to the builder
- Exact join key between fleet entries and snapshot step nodes (**verify live first**: same agent + model + `startedAt` is the expectation, not yet confirmed for workflow children).
- Argument shapes of the `subagent` tool for parallel/workflow launches (read `pi-subagents` params schema).
- Wording of one-liners, emoji, and test fixture design.

## Verification
- Unit: render snapshots for 0 / 1 / 3 orchestrators, collapse rule, truncation line, no-snapshot fallback, bounded size, escaping/redaction of task text; reducer test from a fixture shaped like the documented snapshot; restore resets.
- Live: one real `pi --mode rpc` session with a 2-task `parallel` workflow on a cheap model (as in the v0.2 live checks), confirming grouping, dedupe and task text. Screenshots in the README regenerated from the new fixtures.
