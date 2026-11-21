// Pure logic: turn the pi-subagents async status snapshot into orchestrator groups. No I/O.
import type { AgentRow, Orchestrator, State } from "./core.ts";

export interface SnapWorker { key: string; label: string; agent: string; model: string; state: AgentRow["state"]; startedAt?: number; nested: number; nestedTruncated: boolean }
export interface SnapOrch { id: string; state: Orchestrator["state"]; startedAt?: number; endedAt?: number; truncated: boolean; workers: SnapWorker[] }
export interface Launch { at: number; id?: string; kind: "workflow" | "direct"; tasks: string[]; agents: string[] }

const MAX_ORCH = 20;
const MAX_LAUNCHES = 16;
const LAUNCH_TTL_MS = 600_000;
const CLAIM_WINDOW_MS = 60_000;
const MAX_TASK = 200;

export function mapSnapState(v: unknown): AgentRow["state"] {
	if (v === "running") return "working";
	if (v === "queued") return "waiting";
	if (v === "complete") return "done";
	if (v === "paused") return "paused";
	if (v === "failed" || v === "partial" || v === "stopped" || v === "rejected") return "failed";
	return "idle";
}

// the fleet reports "provider/id:thinking", the snapshot just "provider/id"
const baseModel = (m: unknown): string => String(m ?? "").replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");

const finite = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

// descendants (any depth) that have an agent, for the +N nested count
function agentDescendants(node: any): number {
	let n = 0;
	for (const c of Array.isArray(node?.children) ? node.children : []) {
		if (typeof c?.agent === "string") n++;
		n += agentDescendants(c);
	}
	return n;
}

export function orchestratorsFromSnapshot(snapshot: any): SnapOrch[] | undefined {
	if (!snapshot || !Array.isArray(snapshot.runs)) return undefined;
	const cap = snapshot.caps?.maxChildrenPerNode ?? 8;
	const out: SnapOrch[] = [];
	for (const r of snapshot.runs) {
		if (r?.kind !== "workflow" || typeof r.id !== "string" || !r.id) continue;
		const children = Array.isArray(r.children) ? r.children : [];
		const workers: SnapWorker[] = [];
		for (const c of children) {
			if (c?.kind !== "step" || typeof c.agent !== "string" || typeof c.id !== "string" || !c.id) continue;
			workers.push({
				key: c.id, label: String(c.label ?? ""), agent: c.agent, model: String(c.model ?? ""),
				state: mapSnapState(c.state), startedAt: finite(c.startedAt), nested: agentDescendants(c),
				nestedTruncated: (Array.isArray(c.children) ? c.children.length : 0) >= cap,
			});
		}
		const state = r.state === "complete" ? "done" : r.state === "queued" || r.state === "running" || r.state === "paused" ? "running" : "failed";
		out.push({
			id: r.id, state,
			startedAt: finite(r.startedAt), endedAt: finite(r.endedAt), truncated: children.length >= cap, workers,
		});
	}
	return out;
}

/** Keys of fleet entries that duplicate a snapshot worker (same agent + model, nearest start time). */
export function claimWorkerEntries(entries: any[], orchs: SnapOrch[]): Set<string> {
	const claimed = new Set<string>();
	for (const o of orchs) {
		for (const w of o.workers) {
			if ((w.state !== "working" && w.state !== "paused") || finite(w.startedAt) === undefined) continue;
			let best: string | undefined;
			let bestD = Infinity;
			for (const e of entries) {
				const key = String(e?.key ?? e?.agent ?? "");
				const startedAt = finite(e?.startedAt);
				if (!key || claimed.has(key) || startedAt === undefined || String(e?.agent ?? "") !== w.agent || baseModel(e?.model) !== baseModel(w.model)) continue;
				const d = Math.abs(startedAt - w.startedAt!);
				if (d <= CLAIM_WINDOW_MS && d < bestD) { best = key; bestD = d; }
			}
			if (best !== undefined) claimed.add(best);
		}
	}
	return claimed;
}

export function launchFromArgs(args: any, now: number, id?: string): Launch | undefined {
	if (!args || args.action) return undefined;
	const array = (v: any): any[] => {
		if (typeof v === "string") {
			try { v = JSON.parse(v); } catch { return []; }
		}
		return Array.isArray(v) ? v : [];
	};
	const grouped = args.tasks !== undefined || args.chain !== undefined || args.args?.tasks !== undefined;
	const tasks = array(args.tasks ?? args.args?.tasks);
	const chain = array(args.chain).flatMap((x: any) => Array.isArray(x?.parallel) ? x.parallel : [x]);
	let items = (args.chain === undefined ? tasks : chain).slice(0, 64);
	if (!grouped && !args.workflow) {
		if (!args.agent || !args.task) return undefined;
		items = [args];
	}
	if (!args.workflow && items.length === 0) return undefined;
	const text = (v: any): string => (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, MAX_TASK);
	return {
		at: now, ...(id === undefined ? {} : { id }),
		kind: args.workflow || (grouped && args.async !== false) ? "workflow" : "direct",
		tasks: items.map((t: any) => text(t?.task)),
		agents: items.map((t: any) => text(t?.agent)),
	};
}

export function takeDirectTask(launches: Launch[], agent: string, startedAt: number | undefined, now: number): { task?: string; launches: Launch[] } {
	let best: { li: number; i: number; l: Launch } | undefined;
	for (const [li, l] of launches.entries()) {
		if (l.kind !== "direct" || now - l.at >= LAUNCH_TTL_MS || (startedAt !== undefined && (l.at > startedAt + 5_000 || startedAt - l.at >= LAUNCH_TTL_MS))) continue;
		const i = l.agents.indexOf(agent);
		if (i < 0) continue;
		if (!best || l.at > best.l.at) best = { li, i, l };
		if (startedAt === undefined) break;
	}
	if (!best) return { launches };
	const { li, i, l } = best;
	const task = l.tasks[i]?.replace(/\s+/g, " ").trim().slice(0, MAX_TASK);
	if (!task) return { launches };
	const next = [...launches];
	if (l.agents.length === 1) next.splice(li, 1);
	else next[li] = { ...l, tasks: l.tasks.filter((_, j) => j !== i), agents: l.agents.filter((_, j) => j !== i) };
	return { task, launches: next };
}

export function addLaunch(list: Launch[], l: Launch, now: number): Launch[] {
	return [...list.filter((x) => now - x.at < LAUNCH_TTL_MS), l].slice(-MAX_LAUNCHES);
}

export function applyOrchestrators(s: State, snap: SnapOrch[], o: { launches: Launch[]; now: number; omitted: boolean }): { state: State; launches: Launch[] } {
	const prevOrch = new Map((s.orchestrators ?? []).map((x) => [x.id, x]));
	const prevRow = new Map(s.agents.map((a) => [a.key, a]));
	const direct = s.agents.filter((a) => !a.orch); // (g) rows without an orchestrator are never touched
	let launches = o.launches;
	let next = s.nextOrch ?? 1;
	const orchs: Orchestrator[] = [];
	const rows: AgentRow[] = [];
	for (const so of [...snap].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity))) { // (a) oldest first
		if (so.workers.length === 0 && so.state !== "running" && !prevOrch.has(so.id)) continue;
		const prev = prevOrch.get(so.id);
		let texts: string[] | undefined;
		let n = prev?.n;
		if (n === undefined) { // (b)+(c) a new orchestrator takes the oldest launch that fits its lane count
			n = next++;
			const i = launches.findIndex((l) => l.kind === "workflow" && l.tasks.length > 0
				&& (so.truncated ? l.tasks.length >= so.workers.length : l.tasks.length === so.workers.length)
				&& l.agents.length >= so.workers.length && so.workers.every((w, i) => w.agent === l.agents[i])
				&& (so.startedAt === undefined || (l.at <= so.startedAt + 5_000 && so.startedAt - l.at < LAUNCH_TTL_MS)));
			if (i >= 0) { launches = [...launches]; texts = launches.splice(i, 1)[0].tasks; }
		}
		orchs.push({ id: so.id, n, state: so.state, workers: so.workers.length, startedAt: so.startedAt, endedAt: so.endedAt ?? prev?.endedAt, truncated: so.truncated });
		for (const [i, w] of so.workers.entries()) { // (d) worker rows are rebuilt on every call
			const rk = `${so.id}:${w.key}`;
			const t = texts?.[/^task-(\d+)$/.test(w.key) ? Number(w.key.slice(5)) - 1 : i];
			const task = t !== undefined ? t.replace(/\s+/g, " ").trim().slice(0, MAX_TASK) : prevRow.get(rk)?.task ?? w.label;
			rows.push({ key: rk, name: w.agent, model: w.model, state: w.state, task, orch: so.id, ...(w.nested > 0 ? { nested: w.nested, nestedTruncated: w.nestedTruncated } : {}) });
		}
	}
	// (e) an orchestrator absent from the snapshot has finished, unless the snapshot itself was truncated
	const seen = new Set(snap.map((x) => x.id));
	for (const old of s.orchestrators ?? []) {
		if (seen.has(old.id)) continue;
		const finished = old.state === "running" && !o.omitted;
		orchs.push(finished ? { ...old, state: "done", endedAt: o.now } : old);
		for (const a of s.agents) {
			if (a.orch !== old.id) continue;
			rows.push(finished && a.state === "working" ? { ...a, state: "done" } : a);
		}
	}
	// (f) drop only absent orchestrators (lowest n first); every current snapshot entry keeps its number
	orchs.sort((a, b) => a.n - b.n);
	const dropped = new Set(orchs.filter((x) => !seen.has(x.id)).slice(0, Math.max(0, orchs.length - MAX_ORCH)).map((x) => x.id));
	const kept = orchs.filter((x) => !dropped.has(x.id));
	const keptIds = new Set(kept.map((x) => x.id));
	return { state: { ...s, orchestrators: kept, nextOrch: next, agents: [...direct, ...rows.filter((a) => !a.orch || keptIds.has(a.orch))] }, launches };
}
