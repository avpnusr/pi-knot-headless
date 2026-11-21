// Nested subagent counts from pi-subagents' nested-event files. pi-subagents' own status snapshot loses the nested route
// (it rebuilds jobs from disk keyed by the async id, the route is keyed by the foreground run id), but the route is in the
// `subagent:async-started` payload. Read-only; a changed payload or file shape just means no count. The route holds a
// capability token: nothing of it is ever stored in State, logged or written to the page, only a number leaves.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAX_FILE = 64 * 1024; // pi-subagents' own MAX_EVENT_BYTES
const MAX_PER_POLL = 200;
const MAX_PER_ROUTE = 5000;
const MAX_STATUS = 2 * 1024 * 1024;
const RUNNING = new Set(["running", "queued", "pending", "paused"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type Kid = { agent: string; n: number; input: number; output: number; state: string; usd?: number };
export type Route = { dir: string; runsDir: string; rootRunId: string; seen: Set<string>; kids: Map<string, Kid>; truncated: boolean; done: boolean };

/** Validates the route of an async-started payload: only `<..>/nested-subagent-events/<rootRunId>-<token>/events` is ever read. */
export function openRoute(payload: any): Route | undefined {
	const r = payload?.nestedRoute;
	if (typeof r?.eventSink !== "string" || typeof r?.rootRunId !== "string" || !SAFE_ID.test(r.rootRunId)) return undefined;
	const dir = resolve(r.eventSink);
	const parent = dirname(dir);
	if (basename(dir) !== "events" || basename(dirname(parent)) !== "nested-subagent-events" || !basename(parent).startsWith(`${r.rootRunId}-`)) return undefined;
	const base = dirname(dirname(parent)); // <tmp>/pi-subagents-<uid>
	if (!basename(base).startsWith("pi-subagents")) return undefined;
	return { dir, runsDir: join(base, "nested-subagent-runs", r.rootRunId), rootRunId: r.rootRunId, seen: new Set(), kids: new Map(), truncated: false, done: false };
}

/** Reads event files not seen yet (file names start with a timestamp, so sorted = chronological). Never throws. */
export function pollRoute(r: Route): void {
	try {
		const names = readdirSync(r.dir).filter((n) => n.endsWith(".json") && !n.startsWith(".") && !r.seen.has(n)).sort().slice(0, MAX_PER_POLL);
		for (const name of names) {
			if (r.seen.size >= MAX_PER_ROUTE) { r.truncated = true; return; }
			r.seen.add(name);
			try {
				const f = join(r.dir, name);
				const s = lstatSync(f);
				if (!s.isFile() || s.size > MAX_FILE) continue; // symlinks, dirs and oversized files are skipped
				const ev = JSON.parse(readFileSync(f, "utf8"));
				const id = ev?.child?.id, agent = ev?.child?.path?.[0]?.agent;
				if (ev?.rootRunId !== r.rootRunId || typeof ev?.type !== "string" || !ev.type.startsWith("subagent.nested.") || typeof id !== "string" || typeof agent !== "string") continue;
				const n = Math.max(Array.isArray(ev.child.steps) ? ev.child.steps.length : 0, 1); // a parallel/chain child counts once per step
				const prev = r.kids.get(id);
				const tok = ev.child.totalTokens;
				const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : d);
				r.kids.set(id, { agent, n: Math.max(prev?.n ?? 0, n), input: num(tok?.input, prev?.input ?? 0), output: num(tok?.output, prev?.output ?? 0), state: typeof ev.child.state === "string" ? ev.child.state : prev?.state ?? "running", ...(prev?.usd !== undefined ? { usd: prev.usd } : {}) });
			} catch { /* a half-written or foreign file: ignore it */ }
		}
	} catch { /* route directory gone or unreadable: keep what we have */ }
	for (const [id, k] of r.kids) if (k.usd === undefined && !RUNNING.has(k.state) && SAFE_ID.test(id)) { const u = readUsd(join(r.runsDir, id, "status.json")); if (u !== undefined) k.usd = u; }
}

// list-price cost of one finished nested run (its own status.json; events carry tokens only)
function readUsd(f: string): number | undefined {
	try {
		const s = lstatSync(f);
		if (!s.isFile() || s.size > MAX_STATUS) return undefined;
		const v = JSON.parse(readFileSync(f, "utf8"))?.totalCost?.costUsd;
		return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
	} catch { return undefined; }
}

/** Usage of all nested runs seen: tokens are input/output only (pi-subagents' events carry no cache counts); `pending` = runs still running or without a cost yet. */
export function nestedUsage(routes: Iterable<Route>): { runs: number; input: number; output: number; usd: number; pending: number } {
	const seen = new Set<string>();
	const u = { runs: 0, input: 0, output: 0, usd: 0, pending: 0 };
	for (const r of routes) for (const [id, k] of r.kids) {
		if (seen.has(id)) continue;
		seen.add(id);
		u.runs++; u.input += k.input; u.output += k.output; u.usd += k.usd ?? 0;
		if (RUNNING.has(k.state) || k.usd === undefined) u.pending++;
	}
	return u;
}

/** Nested count per top-level agent name over all routes (same shape as core.nestedByAgent); two launches of one agent do not add up, like the snapshot path. */
export function routeCounts(routes: Iterable<Route>): Map<string, { n: number; truncated: boolean }> {
	const out = new Map<string, { n: number; truncated: boolean }>();
	for (const r of routes) {
		const per = new Map<string, number>();
		for (const k of r.kids.values()) per.set(k.agent, (per.get(k.agent) ?? 0) + k.n);
		for (const [agent, n] of per) {
			const prev = out.get(agent);
			out.set(agent, { n: Math.max(prev?.n ?? 0, n), truncated: r.truncated || !!prev?.truncated });
		}
	}
	return out;
}
