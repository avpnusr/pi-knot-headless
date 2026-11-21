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
	/-----BEGIN [A-Z ]*-----[^\n]*/g,
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
}

const MAX_DECISIONS = 50;

export function newState(now: number, title: string, headModel: string): State {
	return {
		version: 1, title, startedAt: now, lastBeat: now, phase: "idle", headModel, headActivity: "",
		agents: [], questions: [], decisions: [], nextQ: 1, backgroundRunning: 0, mutated: false, decidedThisRun: 0,
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
