import type { Comment } from "./knot.ts";

// Pure logic: guards, redaction, state reducers, inbox mapping. No I/O.

export function isInert(env: Record<string, string | undefined>, mode: string | undefined): boolean {
	if (env.PI_SUBAGENT_CHILD === "1" || env.PI_SUBAGENT_RUNNER_PID) return true;
	return mode !== "tui" && mode !== "rpc";
}

const SECRET_PATTERNS: RegExp[] = [
	/knot_[A-Za-z0-9]{8,}/g,
	/Bearer\s+\S+/g,
	/\bsk-[A-Za-z0-9_-]{12,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{16,}/g,
	/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	/-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_-]{20,}/g,
];

export function redact(text: string, secretValues: string[]): string {
	let out = text;
	for (const v of secretValues) if (v) out = out.split(v).join("[redacted]");
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
}

export function secretValuesFromEnv(env: Record<string, string | undefined>, names: string[]): string[] {
	return names.map((n) => env[n]).filter((v): v is string => typeof v === "string" && v.length >= 8);
}

// ---- state ------------------------------------------------------------------

export type Severity = "minor" | "normal" | "critical";
export interface Question {
	id: string;
	text: string;
	options: string[];
	recommended?: string;
	severity: "normal" | "critical";
	why: string;
	askedAt: number;
	deadline?: number;
	threadId?: string;
}
export interface Decision {
	ts: number;
	by: "model" | "user" | "timeout" | "system";
	text: string;
}
export interface AgentRow {
	key: string;
	name: string;
	model: string;
	state: "working" | "done" | "failed" | "waiting" | "idle" | "paused";
	task: string;
}
export interface State {
	version: 1;
	pageId?: string;
	tokenProvider?: string;
	title: string;
	startedAt: number;
	lastBeat: number;
	phase: "running" | "idle" | "ended";
	headModel: string;
	headActivity: string;
	agents: AgentRow[];
	questions: Question[];
	decisions: Decision[];
	nextQ: number;
	watermark?: { id: string; createdAt: string };
	backgroundRunning: number;
	mutated: boolean;
	decidedThisRun: number;
	dots?: Record<string, number>; // agent name -> palette index, assigned on first sight so dots stay distinct and stable
	ownIds: string[]; // ids of comments this extension posted (never delivered back, even if owner == agent account)
}

const MAX_DECISIONS = 50;

export function newState(now: number, title: string, headModel: string): State {
	return {
		version: 1, title, startedAt: now, lastBeat: now, phase: "idle", headModel, headActivity: "",
		agents: [], questions: [], decisions: [], nextQ: 1, backgroundRunning: 0, mutated: false, decidedThisRun: 0, ownIds: [],
	};
}

export function logDecision(s: State, d: Decision): State {
	return { ...s, decisions: [...s.decisions, d].slice(-MAX_DECISIONS) };
}

export function askQuestion(
	s: State,
	a: { question: string; options?: string[]; recommended?: string; severity: Severity; why?: string },
	now: number,
	timeoutMs: number,
): { state: State; qid?: string; error?: string } {
	if (a.severity === "minor") {
		const text = a.recommended ? `${a.question} → ${a.recommended}` : a.question;
		const st = logDecision(s, { ts: now, by: "model", text });
		return { state: { ...st, decidedThisRun: st.decidedThisRun + 1 } };
	}
	if (a.severity === "normal" && !a.recommended) {
		return { state: s, error: "severity \"normal\" needs a \"recommended\" default (used if the user does not answer in time); use \"critical\" if there is no safe default" };
	}
	const q: Question = {
		id: `Q${s.nextQ}`, text: a.question, options: a.options ?? [], recommended: a.recommended,
		severity: a.severity, why: a.why ?? "", askedAt: now,
		deadline: a.severity === "normal" ? now + timeoutMs : undefined,
	};
	return { state: { ...s, questions: [...s.questions, q], nextQ: s.nextQ + 1, decidedThisRun: s.decidedThisRun + 1 }, qid: q.id };
}

export function answerQuestion(s: State, qid: string, answer: string, by: "user" | "timeout", now: number): State {
	const q = s.questions.find((x) => x.id === qid);
	if (!q) return s;
	const st = { ...s, questions: s.questions.filter((x) => x.id !== qid) };
	return logDecision(st, { ts: now, by, text: `${q.id} ${q.text} → ${answer}` });
}

export function expireQuestions(s: State, now: number): { state: State; expired: Question[] } {
	const expired = s.questions.filter((q) => q.deadline !== undefined && now >= q.deadline);
	let st = s;
	for (const q of expired) st = answerQuestion(st, q.id, `${q.recommended ?? "default"} (auto-decided after timeout)`, "timeout", now);
	return { state: st, expired };
}

// ---- inbox ------------------------------------------------------------------

export type Mapped =
	| { kind: "answer"; qid: string; option?: number; text: string }
	| { kind: "general"; text: string; interpretedQ?: string }
	| { kind: "ignore" };

const MAX_COMMENT = 4096;

// Pads the fractional seconds so "…:05Z", "…:05.5Z" and "…:05.000000Z" compare correctly as strings.
export function normTs(s: string): string {
	const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/.exec(s);
	return m ? `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}${m[3]}` : s;
}

export function newComments(all: Comment[], wm?: { id: string; createdAt: string }): Comment[] {
	const t = (c: Comment) => normTs(c.created_at);
	const cmp = (a: Comment, b: Comment) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const w = wm ? normTs(wm.createdAt) : undefined;
	return [...all].sort(cmp).filter((c) => !wm || t(c) > w! || (t(c) === w && c.id > wm.id));
}

export function mapComment(c: Comment, s: State, owner: string): Mapped {
	if (!c.author_id || c.author_id !== owner) return { kind: "ignore" };
	const body = String(c.body ?? "").slice(0, MAX_COMMENT);

	const threaded = c.parent_id ? s.questions.find((q) => q.threadId && (q.threadId === c.thread_id || q.threadId === c.parent_id)) : undefined;
	if (threaded) {
		const m = /^\s*(\d+)\b\s*(.*)$/s.exec(body);
		return withOption(threaded, m ? Number(m[1]) : undefined, m ? m[2] : body);
	}
	const m = /^\s*Q(\d+)(?:\s+(\d+)\b)?\s*:?\s*(.*)$/is.exec(body);
	if (m) {
		const q = s.questions.find((x) => x.id === `Q${m[1]}`);
		if (q) return withOption(q, m[2] ? Number(m[2]) : undefined, m[3]);
	}
	return { kind: "general", text: body, interpretedQ: s.questions.length === 1 ? s.questions[0].id : undefined };
}

function withOption(q: Question, option: number | undefined, rest: string): Mapped {
	const label = option !== undefined ? q.options[option - 1] : undefined;
	const text = label ? (rest.trim() ? `${label} (${rest.trim()})` : label) : option !== undefined && !rest.trim() ? String(option) : (option !== undefined ? `${option} ${rest}` : rest).trim();
	return { kind: "answer", qid: q.id, option: label ? option : undefined, text };
}

const quote = (t: string) => JSON.stringify(t);

export function composeDelivery(items: { mapped: Mapped; s: State }[]): string {
	const parts: string[] = [];
	for (const { mapped: m, s } of items) {
		if (m.kind === "ignore") continue;
		if (m.kind === "answer") {
			const q = s.questions.find((x) => x.id === m.qid);
			if (!q) continue;
			// everything the model wrote is quoted too: it must not be able to forge a "[Knot message from user]" line
			const opts = q.options.length ? ` — options: ${q.options.map((o, i) => `${i + 1}) ${quote(o)}`).join("; ")}` : "";
			const rec = q.recommended ? ` — recommended: ${quote(q.recommended)}` : "";
			const why = q.why ? ` — why: ${quote(q.why)}` : "";
			parts.push(`Knot answer to ${q.id}: ${quote(q.text)}${opts}${rec}${why} — the user answered: ${quote(m.text)}`);
		} else {
			let t = `[Knot message from user] ${quote(m.text)}`;
			const q = m.interpretedQ ? s.questions.find((x) => x.id === m.interpretedQ) : undefined;
			if (q) t += ` (interpreted as an answer to ${q.id} ${quote(q.text)}; push back if it was not meant that way)`;
			else if (s.questions.length > 1) t += ` (Open questions, not answered by this message: ${s.questions.map((x) => `${x.id} ${quote(x.text)}`).join("; ")})`;
			parts.push(t);
		}
	}
	return parts.join("\n\n");
}

export function timeoutMessage(q: Question, minutes: number): string {
	const after = minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
	return `${q.id} ${quote(q.text)} unanswered on Knot after ${after}; if the user already decided this elsewhere keep that, otherwise proceed with: ${q.recommended ? quote(q.recommended) : "your best judgement"}`;
}

export const PALETTE_SIZE = 6;

/** Gives every agent name a stable palette slot on first sight (next free slot, cycling). */
export function assignDots(s: State): State {
	const dots = { ...(s.dots ?? {}) };
	let changed = false;
	for (const a of s.agents) {
		if (dots[a.name] === undefined) {
			dots[a.name] = Object.keys(dots).length % PALETTE_SIZE;
			changed = true;
		}
	}
	return changed ? { ...s, dots } : s;
}
