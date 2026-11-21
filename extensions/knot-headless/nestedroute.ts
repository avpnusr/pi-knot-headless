// Nested subagent counts from pi-subagents' nested-event files. pi-subagents' own status snapshot loses the nested route
// (it rebuilds jobs from disk keyed by the async id, the route is keyed by the foreground run id), but the route is in the
// `subagent:async-started` payload. Read-only; a changed payload or file shape just means no count. The route holds a
// capability token: nothing of it is ever stored in State, logged or written to the page, only a number leaves.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAX_FILE = 64 * 1024; // pi-subagents' own MAX_EVENT_BYTES
const MAX_PER_POLL = 200;
const MAX_PER_ROUTE = 5000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type Route = { dir: string; rootRunId: string; seen: Set<string>; kids: Map<string, { agent: string; n: number }>; truncated: boolean; done: boolean };

/** Validates the route of an async-started payload: only `<..>/nested-subagent-events/<rootRunId>-<token>/events` is ever read. */
export function openRoute(payload: any): Route | undefined {
	const r = payload?.nestedRoute;
	if (typeof r?.eventSink !== "string" || typeof r?.rootRunId !== "string" || !SAFE_ID.test(r.rootRunId)) return undefined;
	const dir = resolve(r.eventSink);
	const parent = dirname(dir);
	if (basename(dir) !== "events" || basename(dirname(parent)) !== "nested-subagent-events" || !basename(parent).startsWith(`${r.rootRunId}-`)) return undefined;
	return { dir, rootRunId: r.rootRunId, seen: new Set(), kids: new Map(), truncated: false, done: false };
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
				r.kids.set(id, { agent, n: Math.max(r.kids.get(id)?.n ?? 0, n) });
			} catch { /* a half-written or foreign file: ignore it */ }
		}
	} catch { /* route directory gone or unreadable: keep what we have */ }
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
