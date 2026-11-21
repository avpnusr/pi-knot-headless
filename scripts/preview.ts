// Renders three fixture states to Markdown for README screenshots: node scripts/preview.ts <outdir>
// Fixtures are fictional on purpose (no real hosts, ids or task text).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newState, askQuestion, answerQuestion, logDecision, assignDots, type State, type AgentRow } from "../extensions/knot-headless/core.ts";
import { render } from "../extensions/knot-headless/render.ts";

const T0 = Date.UTC(2026, 10, 21, 9, 2);
const at = (min: number) => T0 + min * 60_000;
const row = (name: string, model: string, state: AgentRow["state"], task: string): AgentRow => ({ key: name, name, model, state, task });
const H2 = 2 * 3_600_000;

function running(): State {
	let s = newState(T0, "acme-api · migrate auth to OAuth", "claude-opus-5-5");
	s = { ...s, phase: "running", headActivity: "reviewing the token refresh flow", lastBeat: at(14), backgroundRunning: 2,
		agents: [
			row("architect", "claude-opus-5-5", "done", "design the token store"),
			row("backend-developer", "glm-5.3", "working", "implement refresh endpoint"),
			row("test-engineer", "minimax-m3.1-flash", "working", "write integration tests"),
			row("code-reviewer", "glm-5.3", "idle", "waiting for the diff"),
		] };
	s = assignDots(s);
	s = askQuestion(s, { question: "Store refresh tokens hashed?", recommended: "yes", severity: "minor" }, at(4), H2).state;
	s = askQuestion(s, { question: "Use a 15 minute access token lifetime?", recommended: "15 min", severity: "minor" }, at(6), H2).state;
	s = logDecision(s, { ts: at(9), by: "system", text: "model switched to claude-opus-5-5; page keeps writing with the claude-bridge token" });
	return s;
}

function needsYou(): State {
	let s = running();
	s = askQuestion(s, { question: "Which session store should we use?", options: ["Redis", "Postgres", "In-memory (dev only)"], recommended: "Postgres", severity: "normal", why: "already in the stack; Redis adds an ops burden" }, at(16), H2).state;
	s = askQuestion(s, { question: "Drop the legacy sessions table after the migration?", options: ["Yes, drop it", "Keep it for now"], severity: "critical", why: "irreversible; 2.1M rows" }, at(17), H2).state;
	s = { ...s, lastBeat: at(18), agents: s.agents.map((a) => (a.name === "backend-developer" ? { ...a, state: "waiting" as const, task: "blocked on Q1" } : a)) };
	return s;
}

function ended(): State {
	let s = needsYou();
	s = answerQuestion(s, "Q1", "Postgres", "user", at(31));
	s = answerQuestion(s, "Q2", "Keep it for now", "user", at(33));
	return { ...s, phase: "ended", lastBeat: at(94), backgroundRunning: 0, headActivity: "",
		agents: s.agents.map((a) => ({ ...a, state: "done" as const, task: a.task === "blocked on Q1" ? "implement refresh endpoint" : a.task === "waiting for the diff" ? "review the diff" : a.task })) };
}

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/preview.ts <outdir>");
mkdirSync(out, { recursive: true });
for (const [name, s] of [["running", running()], ["needs-you", needsYou()], ["ended", ended()]] as const) {
	writeFileSync(join(out, `${name}.md`), render(s, { now: at(95), tz: "UTC" }));
}
