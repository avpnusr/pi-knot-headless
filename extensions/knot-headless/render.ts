import { redact, type State, type Question } from "./core.ts";

export function esc(text: string, max = 80): string {
	let t = String(text).replace(/\s+/g, " ").trim();
	if (t.length > max) t = `${t.slice(0, max - 1)}…`;
	return t.replace(/([\\`*_{}\[\]<>#|~@])/g, "\\$1").replace(/:\/\//g, ":\\//"); // no live links, mentions or images
}

/** For plain-text comment bodies: neutralise image/link syntax, bare URLs and @mentions without adding backslashes everywhere. */
export function defang(text: string): string {
	return text.replace(/!\[/g, "! [").replace(/\]\(/g, "] (").replace(/:\/\//g, ":\\//").replace(/@/g, "@\u200b");
}

const PALETTE = ["🟣", "🔵", "🟢", "🟡", "🟠", "🟤"]; // colored circles that render as emoji everywhere (⚫⚪ fall back to text glyphs)
const GLYPH: Record<string, string> = { working: "▶", done: "✅", failed: "❌", waiting: "⏳", idle: "💤", paused: "⏸" };
const BY: Record<string, string> = { model: "🤖", user: "👤", timeout: "⏱", system: "🔄" };
const MAX_AGENTS = 20;
const MAX_DECISIONS_SHOWN = 8;
const MAX_QUESTIONS = 10;

const dot = (s: State, name: string): string => {
	const i = s.dots?.[name];
	if (i !== undefined) return PALETTE[i % PALETTE.length];
	let h = 5381; // fallback for states without assigned dots
	for (const c of name) h = ((h << 5) + h + c.codePointAt(0)!) >>> 0;
	return PALETTE[h % PALETTE.length];
};
const code = (t: string, max = 60): string => `\`${String(t).replace(/[`\n\r]/g, " ").trim().slice(0, max)}\``;

export function render(s: State, o: { now: number; tz?: string; secrets?: string[] }): string {
	const secrets = o.secrets ?? [];
	const e = (t: string, max = 80) => esc(redact(t, secrets), max);
	const hm = (ts: number) =>
		new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: o.tz }).format(ts);
	const icon = s.phase === "running" ? "▶" : s.phase === "idle" ? "💤" : "✅";
	const label = s.phase === "running" ? "▶ running" : s.phase === "idle" ? "💤 idle — comment to give a new task" : "✅ ended";
	const L: string[] = [];

	L.push(`# ${icon} ${e(s.title, 100)}`, "");
	L.push(`> ${label} · started ${hm(s.startedAt)} · heartbeat ${hm(s.lastBeat)}`, "");
	L.push("## 🧠 Head", "", `${code(redact(s.headModel, secrets))}${s.headActivity ? ` — ${e(s.headActivity)}` : ""}`, "");

	L.push("## ❓ Needs you", "");
	if (s.questions.length === 0) L.push("_nothing needs you 🎉_", "");
	for (const q of s.questions.slice(0, MAX_QUESTIONS)) L.push(...question(q, e, hm));
	if (s.questions.length > MAX_QUESTIONS) L.push(`_+${s.questions.length - MAX_QUESTIONS} more questions_`, "");

	L.push("## 🤖 Agents", "");
	if (s.agents.length === 0) L.push("_no subagents yet_", "");
	else {
		L.push("| | Agent | Model | State | Task |", "|---|---|---|---|---|");
		for (const a of s.agents.slice(-MAX_AGENTS)) {
			L.push(`| ${dot(s, a.name)} | ${e(a.name, 40)} | ${e(a.model, 40)} | ${GLYPH[a.state] ?? "•"} ${a.state} | ${e(a.task)} |`);
		}
		if (s.agents.length > MAX_AGENTS) L.push("", `_+${s.agents.length - MAX_AGENTS} older not shown_`);
		L.push("");
	}

	L.push("## 📝 Decisions reported", "");
	if (s.decisions.length === 0) L.push("_none yet_", "");
	else {
		const shown = s.decisions.slice(-MAX_DECISIONS_SHOWN).reverse();
		for (const d of shown) L.push(`- ${hm(d.ts)} ${BY[d.by] ?? "•"} ${e(d.text, 160)}`);
		const older = s.decisions.length - shown.length;
		if (older > 0) L.push("", `_+${older} older_`);
		L.push("");
	}

	if (s.phase === "ended") {
		const mins = Math.max(0, Math.round((s.lastBeat - s.startedAt) / 60_000));
		const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
		const models = [...new Set([s.headModel, ...s.agents.map((a) => a.model)].filter(Boolean))];
		L.push("## ✅ Summary", "", `- duration: ${dur}`, `- models: ${models.map((m) => code(redact(m, secrets))).join(", ")}`);
		if (s.backgroundRunning > 0) L.push(`- ⚠️ ${s.backgroundRunning} background runs still running; results not delivered`);
		L.push("");
	}

	L.push("## 💬 How to answer", "", "Reply **in the question's comment thread**, or comment `Q1 2` (option 2) / `Q1: your text`. Any other comment is sent to the session as a message.", "");
	return L.join("\n");
}

function question(q: Question, e: (t: string, max?: number) => string, hm: (ts: number) => string): string[] {
	const chip = q.severity === "critical" ? "🔴 critical" : "🟡 normal";
	const timing = q.deadline !== undefined ? `auto-default ${hm(q.deadline)}` : "no auto-default";
	const L = [`### ⏳ ${q.id} · ${chip} · asked ${hm(q.askedAt)} · ${timing}`, "", `**${e(q.text, 200)}**`, ""];
	q.options.forEach((opt, i) => L.push(`- ${q.id}.${i + 1} ${e(opt, 120)}${q.recommended === opt ? " ⭐" : ""}`));
	if (q.options.length) L.push("");
	if (q.recommended && !q.options.includes(q.recommended)) L.push(`⭐ recommended: ${e(q.recommended, 120)}`, "");
	if (q.why) L.push(`> why: ${e(q.why, 200)}`, "");
	return L;
}
