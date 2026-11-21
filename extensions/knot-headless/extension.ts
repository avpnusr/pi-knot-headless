// pi wiring. Imports nothing from pi so it can be tested with a fake `pi` (see fakepi.ts).
import { basename } from "node:path";
import {
	isInert, redact, secretValuesFromEnv, newState, askQuestion, answerQuestion, expireQuestions, logDecision,
	newComments, mapComment, composeDelivery, timeoutMessage, type State, type AgentRow, type Question, type Severity,
} from "./core.ts";
import { loadConfig, type Config } from "./config.ts";
import { createKnot, tokenVarFor, KnotAuthError, type Knot } from "./knot.ts";
import { render } from "./render.ts";

export interface Deps {
	now: () => number;
	env: Record<string, string | undefined>;
	makeKnot: (cfg: Config, token: () => string | undefined) => Knot;
	setInterval: (fn: () => void, ms: number) => unknown;
	clearInterval: (h: unknown) => void;
	setTimeout: (fn: () => void, ms: number) => unknown;
	sleep: (ms: number) => Promise<void>;
	log: (msg: string) => void;
	paramsSchema: unknown;
	tz?: string;
}

const ENTRY = "knot-headless";
const POLL_MS = 20_000;
const WRITE_GAP_MS = 15_000;
const HEARTBEAT_MS = 300_000;
const RPC_TIMEOUT_MS = 2_000;
const TIMER_KEY = Symbol.for("pi-knot-headless.timer");
const MAX_ROWS = 30;

export function realDeps(paramsSchema: unknown): Deps {
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	return {
		now: () => Date.now(), env: process.env,
		makeKnot: (cfg, token) => createKnot({ fetch, baseUrl: cfg.url, token, sleep }),
		setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
		setTimeout: (fn, ms) => setTimeout(fn, ms), sleep, log: () => {}, paramsSchema,
	};
}

export interface Handle {
	tick(force?: boolean): Promise<void>;
	state(): State;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function create(pi: any, deps: Deps): Handle {
	let st: State = newState(deps.now(), "", "");
	let cfg: Config | undefined;
	let cfgReason = "";
	let knot: Knot | undefined;
	let ctxRef: any;
	let disabled = false;
	let inertMode = false;
	let owner: string | undefined;
	let timer: unknown;
	let lastMd = "";
	let lastWrite = 0;
	let lastPoll = 0;
	let offline = false;
	let notified = false;
	let firstPrompt = "";
	let warnedRun = false;
	let fleetTimer: unknown;
	let chain: Promise<unknown> = Promise.resolve();
	const hasChildEnv = deps.env.PI_SUBAGENT_CHILD === "1" || !!deps.env.PI_SUBAGENT_RUNNER_PID;
	if (hasChildEnv) return { tick: async () => {}, state: () => st }; // inert inside subagent children
	const handle: Handle = { tick: (f) => serial(() => tickInner(!!f)), state: () => st };

	const secrets = () => secretValuesFromEnv(deps.env, [...Object.values(cfg?.tokenEnv ?? {}), ...(cfg?.secretEnv ?? [])]);
	const clean = (t: string) => redact(t, secrets());
	const log = (m: unknown) => deps.log(clean(String((m as Error)?.message ?? m)));
	const notifyOnce = (msg: string, level = "warning") => {
		if (notified) return;
		notified = true;
		try { ctxRef?.ui?.notify?.(msg, level); } catch { /* ignore */ }
	};
	const setStatus = (text: string | undefined) => { try { ctxRef?.ui?.setStatus?.("knot", text); } catch { /* ignore */ } };
	const active = () => !!cfg && cfg.enabled && !disabled && !inertMode && !!knot;
	const persist = () => { try { pi.appendEntry(ENTRY, st); } catch (e) { log(e); } };
	const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
		const p = chain.then(fn, fn);
		chain = p.catch(() => {});
		return p;
	};
	const guard = <A extends unknown[]>(fn: (...a: A) => unknown) => async (...a: A) => { try { return await fn(...a); } catch (e) { log(e); } };
	const provider = () => st.tokenProvider ?? ctxRef?.model?.provider ?? "*";

	// ---- Knot plumbing --------------------------------------------------------
	async function getOwner(): Promise<string> {
		if (owner) return owner;
		const parent = cfg!.ownerUid ? undefined : await knot!.getPage(cfg!.parentPageId);
		const o = cfg!.ownerUid ?? parent!.createdBy;
		if (!cfg!.ownerUid && st.pageId) {
			const mine = await knot!.getPage(st.pageId);
			if (mine.createdBy === o) {
				disabled = true;
				notifyOnce("pi-knot-headless: set \"ownerUid\" in settings — the parent page was created by the agent's own Knot account, so the owner cannot be inferred.");
				throw new Error("ownerUid required");
			}
		}
		return (owner = o);
	}

	async function ensurePage(): Promise<void> {
		if (st.pageId) return;
		if (!st.title) st = { ...st, title: makeTitle() };
		if (!st.tokenProvider) st = { ...st, tokenProvider: provider() };
		const page = await knot!.createPage(clean(st.title), cfg!.parentPageId);
		// a brand-new page has no history: everything posted from now on is new
		st = { ...st, pageId: page.id, watermark: { id: "", createdAt: "" } };
		persist();
		await getOwner();
	}

	async function postQuestionComments(): Promise<void> {
		for (const q of st.questions) {
			if (q.threadId) continue;
			const lines = [`${q.id} · ${q.severity}`, q.text];
			q.options.forEach((o, i) => lines.push(`${i + 1}) ${o}`));
			if (q.recommended) lines.push(`⭐ recommended: ${q.recommended}`);
			lines.push("Reply in this thread (e.g. \"2\" or free text).");
			const c = await knot!.addComment(st.pageId!, clean(lines.join("\n")).slice(0, 2000));
			st = { ...st, questions: st.questions.map((x) => (x.id === q.id ? { ...x, threadId: c.thread_id } : x)) };
			persist();
		}
	}

	async function ensureBaseline(): Promise<void> {
		if (st.watermark || !st.pageId) return;
		const all = await knot!.listComments(st.pageId);
		const last = newComments(all).at(-1);
		st = { ...st, watermark: last ? { id: last.id, createdAt: last.created_at } : { id: "", createdAt: "" } };
		persist();
	}

	async function deliver(text: string): Promise<boolean> {
		if (!text) return true;
		try {
			await Promise.resolve(pi.sendUserMessage(text, { deliverAs: "steer" }));
			return true;
		} catch (e) {
			log(e);
			return false;
		}
	}

	async function pollComments(): Promise<void> {
		await ensureBaseline();
		const o = await getOwner();
		const all = await knot!.listComments(st.pageId!);
		const fresh = newComments(all, st.watermark);
		if (fresh.length === 0) return;
		const prev = st;
		const last = fresh.at(-1)!;
		let run: State = { ...st, watermark: { id: last.id, createdAt: last.created_at } };
		const items: Parameters<typeof composeDelivery>[0] = [];
		for (const c of fresh) {
			let mapped = mapComment(c, run, o);
			if (mapped.kind === "ignore") continue;
			if (mapped.kind === "answer" && !run.questions.some((q) => q.id === mapped.qid)) mapped = { kind: "general", text: mapped.text };
			items.push({ mapped, s: run });
			if (mapped.kind === "answer") run = answerQuestion(run, mapped.qid, mapped.text, "user", deps.now());
		}
		st = run;
		persist();
		if (!(await deliver(composeDelivery(items)))) {
			st = { ...prev, watermark: prev.watermark };
			persist();
		}
	}

	async function expire(): Promise<void> {
		const r = expireQuestions(st, deps.now());
		if (r.expired.length === 0) return;
		const text = r.expired.map((q) => timeoutMessage(q, cfg!.askTimeoutMinutes)).join("\n\n");
		// commit only after delivery; on failure the questions stay open and expire again next tick
		if (await deliver(text)) {
			st = expireQuestions(st, deps.now()).state;
			persist();
		}
	}

	async function writePage(force: boolean): Promise<void> {
		const now = deps.now();
		if (now - st.lastBeat >= HEARTBEAT_MS) st = { ...st, lastBeat: now };
		const md = render(st, { now, tz: deps.tz, secrets: secrets() });
		if (md === lastMd) return;
		if (!force && now - lastWrite < WRITE_GAP_MS) return;
		await knot!.replace(st.pageId!, md);
		lastMd = md;
		lastWrite = now;
	}

	async function tickInner(force: boolean): Promise<void> {
		if (!active() || !st.pageId) return;
		try {
			const now = deps.now();
			if (force || now - lastPoll >= POLL_MS) {
				lastPoll = now;
				await postQuestionComments();
				await pollComments();
			}
			await expire();
			await writePage(force);
			if (offline) { offline = false; setStatus(undefined); }
		} catch (e) {
			log(e);
			if (e instanceof KnotAuthError) {
				disabled = true;
				notifyOnce(`pi-knot-headless: ${(e as Error).message}`, "error");
				setStatus("knot: disabled");
			} else if (!disabled) {
				offline = true;
				setStatus("knot: offline");
			}
		}
	}

	// ---- subagent collection --------------------------------------------------
	function applyFleet(entries: any[], total: number): void {
		const live = new Map<string, AgentRow>();
		for (const e of entries) {
			const key = String(e.key ?? e.agent);
			live.set(key, { key, name: String(e.agent ?? "agent"), model: String(e.model ?? ""), state: "working", task: String(e.goal ?? "") });
		}
		const kept = st.agents.filter((a) => a.key.startsWith("fg:") || (!live.has(a.key) && (a.state === "done" || a.state === "failed")));
		const vanished = st.agents.filter((a) => !a.key.startsWith("fg:") && !live.has(a.key) && a.state === "working").map((a) => ({ ...a, state: "done" as const }));
		st = { ...st, agents: [...kept, ...vanished, ...live.values()].slice(-MAX_ROWS), backgroundRunning: total };
	}

	function readFleet(): Promise<void> {
		return new Promise((resolve) => {
			if (!st.pageId) return resolve();
			const id = `kh-${deps.now()}-${Math.random().toString(36).slice(2)}`;
			let done = false;
			let off: (() => void) | undefined;
			const finish = (data?: any) => {
				if (done) return;
				done = true;
				try { off?.(); } catch { /* ignore */ }
				const fleet = data?.fleet;
				if (fleet && Array.isArray(fleet.entries)) applyFleet(fleet.entries, Number(fleet.totalActive ?? fleet.entries.length));
				resolve();
			};
			off = pi.events.on(`subagents:rpc:v1:reply:${id}`, (reply: any) => finish(reply?.success ? reply.data : undefined));
			deps.setTimeout(() => finish(), RPC_TIMEOUT_MS);
			pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId: id, method: "status", params: {} });
		});
	}
	const scheduleFleet = () => {
		if (fleetTimer) return;
		fleetTimer = deps.setTimeout(() => {
			fleetTimer = undefined;
			void readFleet().then(() => handle.tick()).catch(log);
		}, 250);
	};

	async function launchTrigger(): Promise<void> {
		if (!active()) return;
		try {
			await serial(async () => { await ensurePage(); await writePage(true); });
		} catch (e) { log(e); }
	}

	// ---- events ---------------------------------------------------------------
	pi.on("session_start", guard(async (event: any, ctx: any) => {
		ctxRef = ctx;
		const prev = (globalThis as any)[TIMER_KEY];
		if (prev) deps.clearInterval(prev);
		inertMode = isInert(deps.env, ctx.mode);
		const r = loadConfig(pi.getSettings?.()?.["pi-knot-headless"], deps.env);
		if (r.ok) { cfg = r.cfg; cfgReason = ""; knot = deps.makeKnot(r.cfg, () => { const v = tokenVarFor(provider(), r.cfg.tokenEnv); return v ? deps.env[v] : undefined; }); }
		else { cfg = undefined; cfgReason = r.reason; knot = undefined; }
		disabled = false; owner = undefined; lastMd = ""; lastWrite = 0; lastPoll = 0;
		const now = deps.now();
		const head = ctx.model?.id ?? "";
		st = newState(now, "", head);
		if (event?.reason !== "new" && event?.reason !== "fork") {
			const saved = [...(ctx.sessionManager?.getBranch?.() ?? [])].reverse().find((e: any) => e.type === "custom" && e.customType === ENTRY);
			if (saved?.data?.version === 1) st = { ...saved.data, phase: "idle", agents: [], headModel: head || saved.data.headModel, backgroundRunning: 0, mutated: false, decidedThisRun: 0 };
		}
		firstPrompt = ""; warnedRun = false;
		if (!active()) {
			if (!cfg && !inertMode && !hasChildEnv && cfgReason) setStatus("knot: not configured");
			return;
		}
		timer = deps.setInterval(() => { void handle.tick(); }, POLL_MS);
		(globalThis as any)[TIMER_KEY] = timer;
		if (st.pageId) { await readFleet(); void handle.tick(true); }
	}));

	pi.on("session_shutdown", guard(async (event: any) => {
		if (timer) { deps.clearInterval(timer); if ((globalThis as any)[TIMER_KEY] === timer) (globalThis as any)[TIMER_KEY] = undefined; timer = undefined; }
		if (!active() || !st.pageId || event?.reason === "reload") return;
		st = { ...st, phase: "ended", lastBeat: deps.now() };
		persist();
		await Promise.race([serial(() => writePage(true)).catch(log), deps.sleep(5000)]);
	}));

	pi.on("before_agent_start", guard((event: any) => { if (!firstPrompt && typeof event?.prompt === "string") firstPrompt = event.prompt; }));

	pi.on("model_select", guard((event: any) => {
		const id = event?.model?.id ?? "";
		st = { ...st, headModel: id };
		if (st.pageId) st = logDecision(st, { ts: deps.now(), by: "system", text: `model switched to ${id}; page keeps writing with the ${st.tokenProvider ?? "?"} token` });
	}));

	pi.on("agent_start", guard(() => {
		warnedRun = false;
		st = { ...st, phase: "running", headActivity: "working", mutated: false, decidedThisRun: 0 };
	}));

	pi.on("tool_execution_start", guard(async (event: any) => {
		st = { ...st, headActivity: `running ${event.toolName}` };
		if (event.toolName === "subagent" && active() && event.args?.async !== true) {
			const a = event.args ?? {};
			const specs: { agent: string; task: string }[] = Array.isArray(a.tasks) ? a.tasks : Array.isArray(a.chain) ? a.chain : a.agent ? [a] : [];
			const rows: AgentRow[] = specs.filter((s) => s?.agent).map((s, i) => ({ key: `fg:${event.toolCallId}:${i}`, name: String(s.agent), model: "", state: "working", task: String(s.task ?? "") }));
			st = { ...st, agents: [...st.agents, ...rows].slice(-MAX_ROWS) };
			void launchTrigger();
		}
	}));

	pi.on("tool_execution_end", guard((event: any) => {
		if (["edit", "write", "bash"].includes(event.toolName)) st = { ...st, mutated: true };
		if (event.toolName === "subagent") {
			const prefix = `fg:${event.toolCallId}:`;
			st = { ...st, agents: st.agents.map((a) => (a.key.startsWith(prefix) ? { ...a, state: event.isError ? "failed" : "done" } : a)) };
		}
	}));

	pi.on("agent_settled", guard(async () => {
		st = { ...st, phase: st.backgroundRunning > 0 ? "running" : "idle", headActivity: "" };
		if (st.pageId && st.mutated && st.decidedThisRun === 0 && !warnedRun) {
			warnedRun = true;
			st = logDecision(st, { ts: deps.now(), by: "system", text: "⚠ run ended with no logged decisions" });
		}
		void handle.tick();
	}));

	pi.events.on("subagent:async-started", guard(() => { void launchTrigger().then(scheduleFleet); }));
	pi.events.on("subagent:child-status", guard(() => { if (st.pageId) scheduleFleet(); }));
	pi.events.on("subagent:jobs-changed", guard(() => { if (st.pageId) scheduleFleet(); }));
	pi.events.on("subagent:async-complete", guard((p: any) => {
		const failed = new Set((Array.isArray(p?.results) ? p.results : []).filter((r: any) => /fail|error|time/i.test(String(r?.status))).map((r: any) => String(r.agent)));
		if (failed.size) st = { ...st, agents: st.agents.map((a) => (failed.has(a.name) && a.state === "working" ? { ...a, state: "failed" } : a)) };
		if (st.pageId) scheduleFleet();
	}));

	// ---- tool + command -------------------------------------------------------
	pi.registerTool({
		name: "knot_ask",
		label: "Knot ask / decision log",
		description:
			"Headless reporting through the user's Knot dashboard. Record a decision you made (severity minor), or ask the user a question that they answer by commenting on the Knot page (severity normal or critical). minor: easy, uncritical, reversible — logged, you continue at once. normal: a real but reversible choice — requires `recommended`; if the user does not answer within the timeout the recommended default applies. critical: hard, irreversible, destructive, security-relevant, costly, externally publishing, or unclear requirements — no default, wait for the user.",
		promptSnippet: "Record decisions and ask the user through the Knot dashboard",
		promptGuidelines: [
			"Use knot_ask to record every non-trivial decision you make (severity minor, put the choice in recommended) and to ask the user whenever a choice is theirs to make.",
			"Use knot_ask with severity critical for anything hard to reverse, destructive, security-relevant, costly, externally publishing, or when requirements are unclear; use normal for real but reversible choices (recommended is required); use minor for easy, uncritical choices. When unsure, choose the higher severity.",
			"Call knot_ask alone in its tool batch. After a normal or critical knot_ask stop work that depends on the answer: it arrives later as a user message starting with 'Knot answer to Qn' or '[Knot message from user]'.",
			"When a subagent's question reaches you, put its replyTo id in the why field of knot_ask and answer the subagent with subagent_supervisor after the user has answered.",
		],
		parameters: deps.paramsSchema,
		async execute(_id: string, p: { question: string; options?: string[]; recommended?: string; severity: Severity; why?: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
			ctxRef = ctx ?? ctxRef;
			const text = (t: string, details: Record<string, unknown> = {}, terminate = false) => ({ content: [{ type: "text", text: t }], details, ...(terminate ? { terminate: true } : {}) });
			if (!cfg || inertMode || disabled || !knot || !cfg.enabled) {
				return text(`Knot reporting is not active (${!cfg ? cfgReason || "not configured" : disabled ? "disabled" : "inactive in this mode"}). Decide yourself and state the decision in your reply; ask the user directly if it is critical.`);
			}
			const before = st;
			const r = askQuestion(st, p, deps.now(), cfg.askTimeoutMinutes * 60_000);
			if (r.error) throw new Error(r.error);
			st = r.state;
			if (p.severity === "minor") {
				persist();
				void launchTrigger().then(() => handle.tick());
				return text("Decision logged on the Knot dashboard. Continue.");
			}
			try {
				await serial(async () => { await ensurePage(); await postQuestionComments(); await writePage(true); });
			} catch (e) {
				st = { ...before, pageId: st.pageId, tokenProvider: st.tokenProvider, title: st.title || before.title };
				log(e);
				throw new Error(`Knot is not reachable (${clean(String((e as Error).message))}); ask the user directly in this session instead.`);
			}
			persist();
			const waits = p.severity === "critical" ? "There is no default: wait for the user." : `If there is no answer within ${cfg.askTimeoutMinutes} min, the default (${p.recommended}) applies and you will be told.`;
			return text(`Posted as ${r.qid} on the Knot dashboard. Stop work that depends on this answer; it arrives as a user message. ${waits}`, { qid: r.qid }, p.severity === "critical");
		},
	});

	pi.registerCommand("knot", {
		description: "pi-knot-headless: /knot on | off | status | open",
		handler: async (args: string, ctx: any) => {
			ctxRef = ctx;
			const a = (args ?? "").trim();
			if (a === "off") { disabled = true; setStatus("knot: off"); ctx.ui.notify("Knot reporting off for this session", "info"); return; }
			if (a === "on") {
				if (!cfg) { ctx.ui.notify(cfgReason || "pi-knot-headless is not configured", "warning"); return; }
				disabled = false; setStatus(undefined);
				await launchTrigger();
				ctx.ui.notify(st.pageId ? `Knot page: ${cfg.url}/doc/${st.pageId}` : "Knot page could not be created", "info");
				return;
			}
			if (a === "open" && cfg && st.pageId) { ctx.ui.notify(`${cfg.url}/doc/${st.pageId}`, "info"); return; }
			ctx.ui.notify(`knot: ${!cfg ? cfgReason : disabled ? "off" : st.pageId ? `${st.phase}, ${st.questions.length} open question(s)${offline ? ", offline" : ""}` : "no page yet"}`, "info");
		},
	});

	function makeTitle(): string {
		const folder = basename(ctxRef?.cwd ?? "") || "session";
		const name = ctxRef?.sessionManager?.getSessionName?.() || firstPrompt.split(/\s+/).filter(Boolean).slice(0, 6).join(" ") || "session";
		return `${folder} · ${name}`;
	}
	return handle;
}
