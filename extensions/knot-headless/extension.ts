// pi wiring. Imports nothing from pi so it can be tested with a fake `pi` (see fakepi.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	isInert, assignDots, nestedByAgent, parseCost, redact, secretValuesFromEnv, newState, askQuestion, answerQuestion, expireQuestions, logDecision,
	newComments, mapComment, composeDelivery, timeoutMessage, looksLikeAsk, mirrorChatAsk, isOwnDelivery, pickResolvable, elide, type State, type AgentRow, type Severity,
} from "./core.ts";
import { openAsyncDir, readStepTexts } from "./steptexts.ts";
import { openRoute, pollRoute, routeCounts, nestedUsage, type Route } from "./nestedroute.ts";
import { loadConfig, type Config } from "./config.ts";
import { createKnot, tokenVarFor, KnotAuthError, KnotResponseError, type Knot, type Comment } from "./knot.ts";
import { render, defang } from "./render.ts";
import { buildSummaryInput, parseSummaryReply, gate, SYSTEM_PROMPT, TITLE_PROMPT } from "./summary.ts";
import { orchestratorsFromSnapshot, claimWorkerEntries, applyOrchestrators, launchFromArgs, addLaunch, takeDirectTask, type Launch } from "./orchestrators.ts";

export interface Deps {
	now: () => number;
	env: Record<string, string | undefined>;
	/** The raw "pi-knot-headless" settings block. Global settings only: a project's .pi/settings.json must not be able to redirect the token. */
	settings: () => unknown;
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
const POLL_SLACK_MS = 2_000;
const WRITE_GAP_MS = 15_000;
const HEARTBEAT_MS = 300_000;
const RPC_TIMEOUT_MS = 2_000;
const COMMENT_MAX_BYTES = 3_500; // Knot rejects comment bodies over 4096 bytes
const TIMER_KEY = Symbol.for("pi-knot-headless.timer");
const MAX_ROWS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELF_OWNER_WARNING = "pi-knot-headless: ownerUid is the agent's own Knot account, so anyone holding that token (the agent's shell, subagents) can answer as you. Use a separate bot token for the agent.";
// Skills (brainstorming, writing-plans, code-review, ...) tell the model to "ask the user" in chat; this keeps those questions on the Knot page too.
export const KNOT_SKILLS_RULE = "Skills do not change the knot_ask rules: every question, approval gate or choice a skill makes you put to the user (brainstorming, writing-plans, code-review, ...) must ALSO go through knot_ask, never only into the chat. Clarifying questions: normal with a recommended default, or critical when there is no safe default. Approval gates (design/plan approval, 'may I build/merge/delete'): critical with options. Choices a skill lets you make for the user: minor, reason in why. The Knot page cannot see the chat, so make each knot_ask self-contained (question, options, recommendation, path of any spec/plan to read), then stop and wait for the answer. Only if knot_ask is unavailable, ask in the chat.";
const MAX_ROUTES = 16;
const SELF_OWNER_TOOL_MESSAGE = "Knot answers are disabled because ownerUid is the agent's own Knot account. Use a separate bot token for the agent, and ask the user directly in this session instead of waiting for a Knot answer.";

export function readGlobalSettings(env: Record<string, string | undefined>): unknown {
	try {
		const dir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))["pi-knot-headless"];
	} catch {
		return undefined;
	}
}

export function realDeps(paramsSchema: unknown): Deps {
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	return {
		now: () => Date.now(), env: process.env, settings: () => readGlobalSettings(process.env),
		makeKnot: (cfg, token) => createKnot({ fetch, baseUrl: cfg.url, token, sleep }),
		setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
		setTimeout: (fn, ms) => setTimeout(fn, ms), sleep, log: () => {}, paramsSchema,
	};
}

export interface Handle {
	tick(force?: boolean): Promise<void>;
	state(): State;
}

const cutBytes = (s: string, max: number) => {
	const b = Buffer.from(s);
	if (b.length <= max) return s;
	let n = max;
	while (n > 0 && (b[n] & 0xc0) === 0x80) n--; // never cut inside a multibyte char (a lone fragment decodes to a 3-byte U+FFFD)
	return b.subarray(0, n).toString();
};
const isLaunch = (a: any) => !!(a && (a.agent || a.tasks || a.chain || a.workflow || a.task)); // not status/list/management calls
let launches: Launch[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function create(pi: any, deps: Deps): Handle {
	let st: State = newState(deps.now(), "", "");
	let cfg: Config | undefined;
	let cfgReason = "";
	let knot: Knot | undefined;
	let ctxRef: any;
	let disabled = false;
	let stopped = false;
	let inertMode = false;
	let toolRegistered = false;
	let timer: unknown;
	let lastMd = "";
	let lastWrite = 0;
	let lastPoll = 0;
	let offline = false;
	const notified = new Set<string>();
	let firstPrompt = "";
	let warnedRun = false;
	let lastCreateTry = 0;
	let lastText = ""; // last assistant text of the current run
	let fleetTimer: unknown;
	const wfDirs = new Map<string, { dir: string; done: boolean; texts: Map<string, string> }>(); // workflow id -> async dir + latest step texts
	const routes = new Map<string, Route>(); // async id -> nested route (in memory only, holds a capability token)
	let chain: Promise<unknown> = Promise.resolve();
	const offs: Array<() => void> = [];

	if (deps.env.PI_SUBAGENT_CHILD === "1" || deps.env.PI_SUBAGENT_RUNNER_PID) return { tick: async () => {}, state: () => st }; // inert inside subagent children
	const handle: Handle = { tick: (f) => serial(() => tickInner(!!f)), state: () => st };

	const secrets = () => secretValuesFromEnv(deps.env, [...Object.values(cfg?.tokenEnv ?? {}), ...(cfg?.secretEnv ?? [])]);
	const clean = (t: string) => redact(t, secrets());
	const log = (m: unknown) => deps.log(clean(String((m as Error)?.message ?? m)));
	const notifyOnce = (msg: string, level = "warning") => {
		if (notified.has(msg)) return;
		notified.add(msg);
		try { ctxRef?.ui?.notify?.(msg, level); } catch { /* ignore */ }
	};
	const setStatus = (text: string | undefined) => { try { ctxRef?.ui?.setStatus?.("knot", text); } catch { /* ignore */ } };
	const active = () => !!cfg && cfg.enabled && !disabled && !stopped && !inertMode && !!knot;
	const persist = () => { try { pi.appendEntry(ENTRY, st); } catch (e) { log(e); } };
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const p = chain.then(fn, fn);
		chain = p.catch(() => {});
		return p;
	}
	const guard = <A extends unknown[]>(fn: (...a: A) => unknown) => async (...a: A) => { try { return await fn(...a); } catch (e) { log(e); } };
	const onEvent = (ev: string, fn: (p: any) => unknown) => { const off = pi.events.on(ev, fn); if (typeof off === "function") offs.push(off); };
	const provider = () => st.tokenProvider ?? ctxRef?.model?.provider ?? "*";
	function knotFailed(e: unknown) {
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

	// ---- Knot plumbing --------------------------------------------------------
	async function ensurePage(): Promise<void> {
		if (st.pageId) return;
		if (!st.title) st = { ...st, title: makeTitle() };
		if (!st.tokenProvider) st = { ...st, tokenProvider: provider() };
		const page = await knot!.createPage(clean(st.title), cfg!.parentPageId);
		const selfOwned = !!page.createdBy && page.createdBy === cfg!.ownerUid;
		// a brand-new page has no history: everything posted from now on is new
		st = { ...st, pageId: page.id, pageCreator: page.createdBy, watermark: { id: "", createdAt: "" }, ...(selfOwned ? { selfOwned: true } : {}) };
		persist();
		if (selfOwned) notifyOnce(SELF_OWNER_WARNING);
	}

	async function postQuestionComments(): Promise<void> {
		for (const q of st.questions) {
			if (q.threadId) continue;
			const lines = [`${q.id} · ${q.severity}`, q.text];
			q.options.forEach((o, i) => lines.push(`${i + 1}) ${o}`));
			if (q.recommended) lines.push(`⭐ recommended: ${q.recommended}`);
			lines.push("Reply in this thread (e.g. \"2\" or free text).");
			const c = await knot!.addComment(st.pageId!, cutBytes(defang(clean(lines.join("\n"))), COMMENT_MAX_BYTES));
			st = { ...st, ownIds: [...(st.ownIds ?? []), c.id].slice(-100), questions: st.questions.map((x) => (x.id === q.id ? { ...x, threadId: c.thread_id } : x)) };
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

	async function pollComments(): Promise<Comment[] | undefined> {
		if (st.selfOwned) return;
		await ensureBaseline();
		const all = await knot!.listComments(st.pageId!);
		if (stopped || st.phase === "ended") return;
		const fresh = newComments(all, st.watermark);
		if (fresh.length === 0) return all;
		const prev = st;
		const last = fresh.at(-1)!;
		let run: State = { ...st, watermark: { id: last.id, createdAt: last.created_at } };
		const items: Parameters<typeof composeDelivery>[0] = [];
		for (const c of fresh) {
			if ((run.ownIds ?? []).includes(c.id)) continue;
			let mapped = mapComment(c, run, cfg!.ownerUid);
			if (mapped.kind === "ignore") continue;
			if (mapped.kind === "answer" && !run.questions.some((q) => q.id === mapped.qid)) mapped = { kind: "general", text: mapped.text };
			items.push({ mapped, s: run });
			if (mapped.kind === "answer") run = answerQuestion(run, mapped.qid, mapped.text, "user", deps.now());
		}
		st = run;
		if (items.length === 0) return all; // only foreign/own comments: advance in memory, no need to grow the session file
		persist();
		if (!(await deliver(composeDelivery(items)))) {
			st = prev;
			persist();
		}
		return all;
	}

	// threads whose resolve was refused; not retried within this process
	const refusedThreads = new Set<string>();
	/** Hides finished threads (everything delivered, not an open question) beyond the newest 5. Best effort: nothing here may disable reporting or block the page write. */
	async function cleanupThreads(all: Comment[]): Promise<void> {
		if (!active() || st.selfOwned || st.phase === "ended" || !st.watermark || !st.pageId) return;
		for (const id of pickResolvable(all, st.watermark, st.questions.flatMap((q) => (q.threadId ? [q.threadId] : [])), refusedThreads)) {
			try {
				const r = await knot!.resolveThread(st.pageId!, id);
				if (r !== "ok") refusedThreads.add(id); // "gone" with resolved_at still unset would otherwise be retried every poll
				if (r === "refused") break;
			} catch (e) { log(e); break; }
		}
	}

	// needs no network: a `normal` question must time out even while Knot is down or reporting is switched off
	async function expire(): Promise<void> {
		if (!cfg || stopped) return;
		const now = deps.now();
		const r = expireQuestions(st, now);
		if (r.expired.length === 0) return;
		const text = r.expired.map((q) => timeoutMessage(q, cfg!.askTimeoutMinutes)).join("\n\n");
		// commit only after delivery; on failure the questions stay open and expire again next tick
		if (await deliver(text)) {
			st = expireQuestions(st, now).state;
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
		if (stopped || st.phase === "ended") return; // a closing session must not poll and swallow an answer it will never process
		try { await expire(); } catch (e) { log(e); }
		if (!active() || !st.pageId) return;
		try {
			const now = deps.now();
			let listed: Comment[] | undefined;
			if (force || now - lastPoll >= POLL_MS - POLL_SLACK_MS) {
				lastPoll = now;
				try { await postQuestionComments(); } catch (e) { if (e instanceof KnotAuthError) throw e; log(e); }
				// an oversized/malformed comment list must not also stop the dashboard writes; a real outage still goes to knotFailed
				try { listed = await pollComments(); } catch (x) { if (!(x instanceof KnotResponseError)) throw x; log(x); }
				scheduleFleet();
			}
			await writePage(force);
			if (listed) { try { await cleanupThreads(listed); } catch (e) { log(e); } }
			if (offline) { offline = false; setStatus(undefined); }
		} catch (e) {
			knotFailed(e);
		}
	}

	// ---- subagent collection --------------------------------------------------
	function applyFleet(entries: any[], total: number, omitted: number, snapshot?: unknown): void {
		const nestedMap = nestedByAgent(snapshot);
		for (const [name, c] of routeCounts(routes.values())) { // the snapshot never carries nested runs in current pi-subagents; keep the larger count so it self-heals upstream
			const s = nestedMap.get(name);
			if (!s || c.n >= s.n) nestedMap.set(name, c);
		}
		const snap = orchestratorsFromSnapshot(snapshot);
		const claimed = snap?.length ? claimWorkerEntries(entries, snap) : new Set<string>();
		const directEntries = snap?.length ? entries.filter((e) => !claimed.has(String(e.key ?? e.agent)) && e.agent !== "workflow") : entries;
		const live = new Map<string, AgentRow>();
		for (const e of directEntries) {
			const key = String(e.key ?? e.agent);
			const name = String(e.agent ?? "agent");
			const seen = nestedMap.get(name);
			const prev = st.agents.find((a) => !a.orch && a.key === key);
			const n = Math.max(seen?.n ?? 0, prev?.nested ?? 0);
			let task = prev?.task ?? String(e.goal ?? e.role ?? "");
			if (!prev) {
				const r = takeDirectTask(launches, name, e.startedAt, deps.now());
				if (!task) task = r.task ?? "";
				launches = r.launches;
			}
			live.set(key, { key, name, model: String(e.model ?? ""), state: "working", task, ...(n ? { nested: n, nestedTruncated: seen ? seen.truncated : !!prev?.nestedTruncated } : {}) });
		}
		// a row that left the fleet has finished; if the fleet was truncated we cannot tell, so keep it as it was
		const carried = st.agents.filter((a) => !a.orch && !live.has(a.key)).map((a) => {
			const c = nestedMap.get(a.name); // events can land after the row left the fleet
			const row = c && c.n > (a.nested ?? 0) ? { ...a, nested: c.n, nestedTruncated: c.truncated } : a;
			return row.state === "working" && omitted === 0 ? { ...row, state: "done" as const } : row;
		});
		let all = [...carried, ...live.values()];
		const dropped = Math.max(0, all.length - MAX_ROWS);
		all = all.slice(-MAX_ROWS); // only direct rows compete for MAX_ROWS; orchestrator rows are rebuilt below
		if (snap) {
			const r = applyOrchestrators({ ...st, agents: [...all, ...st.agents.filter((a) => a.orch)] }, snap, { launches, now: deps.now(), omitted: Number((snapshot as any)?.omitted?.runs ?? 0) > 0, stepTexts: new Map([...wfDirs].map(([id, w]) => [id, w.texts])) });
			st = r.state;
			launches = r.launches;
			all = st.agents;
		}
		st = assignDots({ ...st, agents: all, agentsDropped: (st.agentsDropped ?? 0) + dropped, backgroundRunning: total });
	}

	// one request/reply round trip to pi-subagents' in-process RPC; resolves undefined on timeout or when pi-subagents is absent
	function rpc(method: string): Promise<any> {
		return new Promise((resolve) => {
			if (stopped) return resolve(undefined);
			const id = `kh-${deps.now()}-${Math.random().toString(36).slice(2)}`;
			let done = false;
			let off: (() => void) | undefined;
			const finish = (data?: any) => {
				if (done) return;
				done = true;
				try { off?.(); } catch { /* ignore */ }
				resolve(data);
			};
			off = pi.events.on(`subagents:rpc:v1:reply:${id}`, (reply: any) => finish(reply?.success ? reply.data : undefined));
			deps.setTimeout(() => finish(), RPC_TIMEOUT_MS);
			pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId: id, method, params: {} });
		});
	}

	function updateNestedCost() {
		const u = nestedUsage(routes.values());
		if (u.runs > 0) st = { ...st, nestedCost: { runs: u.runs, input: u.input, output: u.output, usd: u.usd, lowerBound: u.pending > 0, at: deps.now() } };
	}

	async function readFleet(): Promise<void> {
		if (!st.pageId || stopped) return;
		for (const r of routes.values()) if (!r.done) pollRoute(r);
		updateNestedCost();
		for (const w of wfDirs.values()) if (!w.done) w.texts = readStepTexts(w.dir);
		const data = await rpc("status");
		try {
			const fleet = data?.fleet;
			if (!stopped && fleet && Array.isArray(fleet.entries)) applyFleet(fleet.entries, Number(fleet.totalActive ?? fleet.entries.length), Number(fleet.omitted ?? 0), data.asyncSnapshot);
		} catch (e) { log(e); }
	}

	// ---- optional summarizer (only exists when the user configured one) ----------
	let gen = 0; // bumped on session_start and session_shutdown: async work from an older session must not write into a newer one
	let sumAbort: AbortController | undefined;
	let summarizing = false;
	let lastSumAt = 0;
	const sumTimes: number[] = [];
	async function summarize(ending = false): Promise<void> {
		const sc = cfg?.summarizer;
		if (!sc || !active() || summarizing || !st.pageId || !ctxRef?.modelRegistry) return; // honours /knot off, enabled:false, auth failures and inert modes
		const secretsNow = secrets();
		const input = buildSummaryInput(st, secretsNow);
		const wantTitle = sc.title && !st.titled && !ending; // never rename while the session is going down
		const fp = input.fp + (wantTitle ? "t" : "");
		const now = deps.now();
		if (!gate({ now, lastAt: lastSumAt, times: sumTimes, sessionCalls: st.sum?.attempts ?? st.sum?.calls ?? 0, fp, lastFp: st.summaryFp, ending })) return;
		const slash = sc.model.indexOf("/");
		const model = ctxRef.modelRegistry.find(sc.model.slice(0, slash), sc.model.slice(slash + 1));
		if (!model) { notifyOnce(`pi-knot-headless: summarizer model "${sc.model}" is not available; the summarizer stays off.`); return; }
		summarizing = true;
		lastSumAt = now;
		sumTimes.push(now);
		const g = gen;
		sumAbort = new AbortController();
		st = { ...st, sum: { calls: st.sum?.calls ?? 0, tokens: st.sum?.tokens ?? 0, usd: st.sum?.usd ?? 0, attempts: (st.sum?.attempts ?? st.sum?.calls ?? 0) + 1 } }; // every attempt counts toward the session cap
		try {
			const msg = await ctxRef.modelRegistry.complete(
				model,
				{ systemPrompt: SYSTEM_PROMPT + (wantTitle ? TITLE_PROMPT : ""), messages: [{ role: "user", content: [{ type: "text", text: input.text }], timestamp: now }] },
				{ signal: AbortSignal.any([AbortSignal.timeout(ending ? 3000 : 20_000), sumAbort.signal]) },
			);
			if (g !== gen || stopped) return;
			if (msg?.stopReason === "error" || msg?.stopReason === "aborted") throw new Error(msg.errorMessage || "summarizer call failed");
			const text = (Array.isArray(msg?.content) ? msg.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("\n");
			const u = msg?.usage;
			st = { ...st, sum: { attempts: st.sum?.attempts ?? 0, calls: (st.sum?.calls ?? 0) + 1, tokens: (st.sum?.tokens ?? 0) + (Number.isFinite(u?.totalTokens) ? u.totalTokens : 0), usd: (st.sum?.usd ?? 0) + (Number.isFinite(u?.cost?.total) ? u.cost.total : 0) } };
			let renamed = st.titled;
			const r = parseSummaryReply(text, wantTitle, secretsNow);
			if (r.summary) st = { ...st, summary: { text: r.summary, model: sc.model, at: now } };
			if (r.title && st.pageId) {
				const folder = basename(ctxRef?.cwd ?? "") || "session";
				const title = `${folder} · ${r.title}`;
				try { await knot!.rename(st.pageId, clean(title)); renamed = true; if (g === gen && !stopped) st = { ...st, title: clean(title) }; } catch (e) { log(e); renamed = true; }
			}
			if (g !== gen || stopped) return;
			// fingerprint after the title decision, so applying the title does not cause one more identical call
			st = { ...st, titled: renamed, summaryFp: input.fp + (sc.title && !renamed ? "t" : "") };
			persist();
		} catch (e) {
			log(e); // the page simply keeps its previous summary
		} finally {
			summarizing = false;
			sumAbort = undefined;
		}
	}

	let costPending = false;
	// read after a run settles (pi-subagents asks for this timing); the last value is what the ended page shows
	async function readCost(): Promise<void> {
		if (!st.pageId || stopped || costPending) return;
		costPending = true;
		const g = gen;
		try {
			const c = parseCost(await rpc("cost"), deps.now());
			if (c && g === gen && !stopped) st = { ...st, cost: c };
		} catch (e) { log(e); } finally { costPending = false; }
	}
	function scheduleFleet() {
		if (fleetTimer || stopped || !st.pageId) return;
		fleetTimer = deps.setTimeout(() => {
			fleetTimer = undefined;
			if (stopped) return;
			void readFleet().then(() => handle.tick()).catch(log);
		}, 250);
	}

	async function launchTrigger(): Promise<void> {
		if (!active()) return;
		try {
			await serial(async () => { await ensurePage(); await writePage(true); });
			if (offline) { offline = false; setStatus(undefined); } // a successful page write proves Knot is back, even when no tick runs yet
		} catch (e) { knotFailed(e); }
	}

	// ---- events ---------------------------------------------------------------
	pi.on("session_start", guard(async (event: any, ctx: any) => {
		launches = [];
		routes.clear();
		wfDirs.clear();
		lastCreateTry = 0;
		ctxRef = ctx;
		stopped = false;
		gen++;
		const prev = (globalThis as any)[TIMER_KEY];
		if (prev) deps.clearInterval(prev);
		inertMode = isInert(deps.env, ctx.mode);
		const r = loadConfig(deps.settings(), deps.env);
		if (r.ok) { cfg = r.cfg; cfgReason = ""; knot = deps.makeKnot(r.cfg, () => { const v = tokenVarFor(provider(), r.cfg.tokenEnv); return v ? deps.env[v] : undefined; }); }
		else { cfg = undefined; cfgReason = r.reason; knot = undefined; }
		disabled = false; lastMd = ""; lastWrite = 0; lastPoll = 0;
		const now = deps.now();
		const head = ctx.model?.id ?? "";
		st = newState(now, "", head);
		if (event?.reason !== "new" && event?.reason !== "fork") {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			const saved = [...branch].reverse().find((e: any) => e.type === "custom" && e.customType === ENTRY);
			const newest = [...(ctx.sessionManager?.getEntries?.() ?? branch)].reverse().find((e: any) => e.type === "custom" && e.customType === ENTRY);
			if (saved?.data?.version === 1) {
				const d = saved.data;
				const counts = d.counts ?? (d.decisions ?? []).reduce((c: any, x: any) => (x.by === "system" ? c : { ...c, [x.by]: (c[x.by] ?? 0) + 1 }), { model: 0, user: 0, timeout: 0 });
				st = { ...d, counts, phase: "idle", terminalPrompt: undefined, agents: [], orchestrators: [], agentsDropped: (d.agentsDropped ?? 0) + (d.agents?.length ?? 0), headModel: head || d.headModel, backgroundRunning: 0, mutated: false, decidedThisRun: 0 };
				if (newest?.data?.version === 1 && newest.data.pageId === st.pageId && newest.data.watermark) st = { ...st, watermark: newest.data.watermark, ownIds: newest.data.ownIds ?? [] };
				if (st.pageId !== undefined && !UUID.test(st.pageId)) {
					st = { ...st, pageId: undefined, pageCreator: undefined, selfOwned: undefined, watermark: undefined, ownIds: [], questions: st.questions.map((q) => ({ ...q, threadId: undefined })) };
				}
				if (st.pageCreator && cfg) st = { ...st, selfOwned: st.pageCreator === cfg.ownerUid ? true : undefined }; // re-check against the current ownerUid (pages from before pageCreator was stored keep their flag)
				if (!cfg?.summarizer) st = { ...st, summary: undefined, summaryFp: undefined }; // the user switched the summarizer off: stop showing old text
			}
		}
		st = { ...st, sessionId: ctx.sessionManager?.getSessionId?.() ?? undefined }; // the open session, not a saved one
		firstPrompt = ""; warnedRun = false;
		notified.delete(SELF_OWNER_WARNING);
		if (st.selfOwned) notifyOnce(SELF_OWNER_WARNING);
		if (!active()) {
			if (!cfg && !inertMode && cfgReason) setStatus("knot: not configured");
			return;
		}
		registerAskTool();
		timer = deps.setInterval(() => { void handle.tick(); }, POLL_MS);
		(globalThis as any)[TIMER_KEY] = timer;
		if (st.pageId) { scheduleFleet(); void handle.tick(true); }
	}));

	pi.on("session_shutdown", guard(async (event: any) => {
		if (timer) { deps.clearInterval(timer); if ((globalThis as any)[TIMER_KEY] === timer) (globalThis as any)[TIMER_KEY] = undefined; timer = undefined; }
		const finalWrite = active() && !!st.pageId && event?.reason !== "reload";
		if (finalWrite) {
			st = { ...st, phase: "ended", lastBeat: deps.now() };
			persist();
		}
		if (finalWrite) await Promise.race([readCost(), deps.sleep(2500)]); // children that finished after the last settled run
		if (finalWrite) await Promise.race([summarize(true), deps.sleep(3500)]); // bounded: the process may be going down
		const write = finalWrite ? serial(() => writePage(true)).catch(log) : Promise.resolve();
		stopped = true;
		gen++;
		sumAbort?.abort();
		// from here on this instance never touches pi or Knot again (the new instance after a reload/new/resume/fork takes over)
		for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
		if (finalWrite) await Promise.race([write, deps.sleep(5000)]);
	}));

	pi.on("before_agent_start", guard((event: any) => { if (!firstPrompt && typeof event?.prompt === "string") firstPrompt = event.prompt; }));

	pi.on("model_select", guard((event: any) => {
		const id = event?.model?.id ?? "";
		st = { ...st, headModel: id };
		if (st.pageId) st = logDecision(st, { ts: deps.now(), by: "system", text: `model switched to ${id}; page keeps writing with the ${st.tokenProvider ?? "?"} token` });
	}));

	const textOf = (m: any): string => (typeof m?.content === "string" ? m.content : (Array.isArray(m?.content) ? m.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("\n")).trim();
	pi.on("message_end", guard((event: any) => {
		const m = event?.message;
		if (m?.role === "assistant") {
			const t = textOf(m);
			if (t) {
				lastText = t;
				// what the CLI shows is what the page shows; in memory only (persisted at agent_settled), the page write is throttled
				st = { ...st, lastMessage: { text: elide(clean(t)), at: deps.now() } };
				if (!st.pageId && active() && deps.now() - lastCreateTry >= POLL_MS) { lastCreateTry = deps.now(); void launchTrigger(); } // the first message of a session creates the page; retried at most once per poll interval while Knot is down
			}
		} else if (m?.role === "user" && st.questions.some((q) => q.mirrored) && !isOwnDelivery(textOf(m))) {
			// the user continued in the chat: a copied-from-chat question is obsolete. Our own steers (answers, timeouts, comments) start runs too and must not drop it.
			const dropped = st.questions.filter((q) => q.mirrored);
			st = { ...st, questions: st.questions.filter((q) => !q.mirrored) };
			for (const q of dropped) st = logDecision(st, { ts: deps.now(), by: "system", text: `${q.id} dropped: you continued in the chat` });
		}
	}));

	pi.on("agent_start", guard(() => {
		lastText = "";
		st = { ...st, phase: "running", headActivity: "working" };
	}));

	// pi dialogs (confirm/select/input/...) only answer in the terminal: the page says that something waits there
	pi.on("ui_prompt_start", guard((event: any) => {
		st = { ...st, terminalPrompt: { kind: String(event?.kind ?? "prompt").slice(0, 20), title: typeof event?.title === "string" ? clean(event.title).slice(0, 200) : undefined, at: deps.now() } };
		if (active()) void launchTrigger().then(() => handle.tick(true)).catch(log);
	}));
	pi.on("ui_prompt_end", guard(() => {
		if (!st.terminalPrompt) return;
		st = { ...st, terminalPrompt: undefined };
		if (active() && st.pageId) void handle.tick(true).catch(log);
	}));

	pi.on("tool_execution_start", guard((event: any) => {
		st = { ...st, headActivity: `running ${event.toolName}` };
		if (event.toolName === "subagent") {
			const l = launchFromArgs(event.args, deps.now(), event.toolCallId);
			if (l) launches = addLaunch(launches, l, deps.now());
		}
		if (event.toolName === "subagent" && isLaunch(event.args) && active()) void launchTrigger().then(scheduleFleet);
	}));

	pi.on("tool_execution_end", guard((event: any) => {
		if (["edit", "write", "bash"].includes(event.toolName)) st = { ...st, mutated: true };
		if (event.toolName === "subagent") {
			if (event.isError) launches = launches.filter((l) => l.id !== event.toolCallId);
			scheduleFleet();
		}
	}));

	pi.on("agent_settled", guard((event: any) => {
		st = { ...st, phase: st.backgroundRunning > 0 ? "running" : "idle", headActivity: "" };
		if (st.pageId && st.mutated && st.decidedThisRun === 0 && !warnedRun) {
			warnedRun = true;
			st = logDecision(st, { ts: deps.now(), by: "system", text: "⚠ run ended with no logged decisions" });
		}
		st = { ...st, mutated: false, decidedThisRun: 0, runs: (st.runs ?? 0) + (st.pageId ? 1 : 0) };
		// a question asked only in the chat becomes a real one (the message itself is already on the page via message_end)
		const text = clean(lastText); // redact before any cut, so a token cannot be split into an unrecognisable fragment
		lastText = "";
		const asks = active() && !!text && !event?.aborted && st.questions.length === 0 && !st.selfOwned && looksLikeAsk(text);
		if (asks) st = mirrorChatAsk(st, text, deps.now()).state;
		if (active()) persist();
		const retryCreate = active() && !st.pageId && deps.now() - lastCreateTry >= POLL_MS; // the first page creation failed: a short run must not leave the session without a page
		if (retryCreate) lastCreateTry = deps.now();
		if (asks || retryCreate || (active() && st.pageId)) void launchTrigger().then(() => handle.tick(true)).catch(log); // the final message must not wait for the next tick
		void readCost().then(() => handle.tick()).catch(log);
		void summarize().then(() => handle.tick()).catch(log); // independent of the cost read: pi-subagents may be absent
	}));

	onEvent("subagent:async-started", guard((p: any) => {
		const r = openRoute(p);
		if (r && typeof p?.id === "string") {
			routes.set(p.id, r);
			if (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value as string);
		}
		const dir = openAsyncDir(p);
		if (dir) {
			wfDirs.set(p.id, { dir, done: false, texts: new Map() });
			if (wfDirs.size > MAX_ROUTES) wfDirs.delete(wfDirs.keys().next().value as string);
		}
		void launchTrigger().then(scheduleFleet);
	}));
	onEvent("subagent:child-status", guard(() => scheduleFleet()));
	onEvent("subagent:jobs-changed", guard(() => scheduleFleet()));
	onEvent("subagent:async-complete", guard((p: any) => {
		const r = routes.get(String(p?.id));
		const w = wfDirs.get(String(p?.id));
		if (w) { w.texts = readStepTexts(w.dir); w.done = true; }
		if (r) { pollRoute(r); r.done = true; updateNestedCost(); } // last read; the count stays on the row
		// the completion notice reaches the session shortly after this event, and only then can the cost RPC resolve this run
		if (st.pageId) deps.setTimeout(() => { void readCost().then(() => handle.tick()).catch(log); }, 3000);
		const failed = new Set((Array.isArray(p?.results) ? p.results : []).filter((r: any) => /fail|error|time/i.test(String(r?.status))).map((r: any) => String(r.agent)));
		// jobs-changed usually arrives first and has already turned the row "done", so flip done -> failed too
		if (failed.size) st = { ...st, agents: st.agents.map((a) => (failed.has(a.name) && a.state !== "failed" ? { ...a, state: "failed" as const } : a)) };
		scheduleFleet();
	}));

	// ---- tool + command -------------------------------------------------------
	function registerAskTool() { // its promptGuidelines reach the system prompt only while the tool is registered, so children, enabled:false and unconfigured sessions stay untouched
		if (toolRegistered) return;
		toolRegistered = true;
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
				KNOT_SKILLS_RULE,
				"When a subagent's question reaches you, put its replyTo id in the why field of knot_ask and answer the subagent with subagent_supervisor after the user has answered.",
			],
			parameters: deps.paramsSchema,
			async execute(_id: string, p: { question: string; options?: string[]; recommended?: string; severity: Severity; why?: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
				ctxRef = ctx ?? ctxRef;
				const text = (t: string, details: Record<string, unknown> = {}, terminate = false) => ({ content: [{ type: "text", text: t }], details, ...(terminate ? { terminate: true } : {}) });
				if (!active()) {
					return text(`Knot reporting is not active (${disabled ? "disabled or Knot rejected the token" : "stopped"}). Decide yourself and state the decision in your reply; ask the user directly if it is critical.`);
				}
				if (st.selfOwned && p.severity !== "minor") return text(SELF_OWNER_TOOL_MESSAGE);
				if (offline && p.severity !== "minor") throw new Error("Knot is currently offline; ask the user directly in this session instead.");
				const r = askQuestion(st, p, deps.now(), cfg!.askTimeoutMinutes * 60_000);
				if (r.error) throw new Error(r.error);
				st = r.state;
				if (p.severity === "minor") {
					persist();
					void launchTrigger().then(() => handle.tick());
					return text("Decision logged on the Knot dashboard. Continue.");
				}
				try {
					await serial(async () => {
						await ensurePage();
						if (!st.selfOwned) { await postQuestionComments(); await writePage(true); }
					});
				} catch (e) {
					// undo only this question: a concurrent tick may meanwhile have delivered an answer, which must stay delivered
					st = { ...st, questions: st.questions.filter((q) => q.id !== r.qid), decidedThisRun: Math.max(0, st.decidedThisRun - 1) };
					persist();
					knotFailed(e);
					throw new Error(`Knot is not reachable (${clean(String((e as Error).message))}); ask the user directly in this session instead.`);
				}
				if (st.selfOwned) {
					st = { ...st, questions: st.questions.filter((q) => q.id !== r.qid), decidedThisRun: Math.max(0, st.decidedThisRun - 1) };
					persist();
					return text(SELF_OWNER_TOOL_MESSAGE);
				}
				persist();
				const waits = p.severity === "critical" ? "There is no default: wait for the user." : `If there is no answer within ${cfg!.askTimeoutMinutes} min, the default (${p.recommended}) applies and you will be told.`;
				return text(`Posted as ${r.qid} on the Knot dashboard. Stop work that depends on this answer; it arrives as a user message. ${waits}`, { qid: r.qid }, p.severity === "critical");
			},
		});
	}

	pi.registerCommand("knot", {
		description: "pi-knot-headless: /knot on | off | status | open",
		handler: async (args: string, ctx: any) => {
			ctxRef = ctx;
			const a = (args ?? "").trim();
			if (a === "off") { disabled = true; setStatus("knot: off"); ctx.ui.notify("Knot reporting off for this session", "info"); return; }
			if (a === "on") {
				if (!cfg) { ctx.ui.notify(cfgReason || "pi-knot-headless is not configured", "warning"); return; }
				disabled = false; offline = false; setStatus(undefined);
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
