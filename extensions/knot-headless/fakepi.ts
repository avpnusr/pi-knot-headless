// Test helpers: a fake `pi`, a fake Knot server and a harness wiring them to create().
import { create, type Deps, type Handle } from "./extension.ts";
import type { Comment, Knot } from "./knot.ts";

export const OWNER = "0aaaaaaa-0000-4000-8000-000000000001";
export const BOT = "0bbbbbbb-0000-4000-8000-000000000002";
export const PARENT = "0ccccccc-0000-4000-8000-000000000003";

export class FakeKnot implements Knot {
	replaces: string[] = [];
	created: string[] = [];
	comments: Comment[] = [];
	calls = 0;
	failWith?: Error;
	failReplace?: Error;
	private seq = 0;
	private chk() { this.calls++; if (this.failWith) throw this.failWith; }
	private stamp() { return `2026-11-21T10:00:${String(++this.seq).padStart(2, "0")}.000000Z`; }
	async createPage(title: string) { this.chk(); this.created.push(title); return { id: `page${this.created.length}`, createdBy: BOT }; }
	async replace(_id: string, md: string) { this.chk(); if (this.failReplace) throw this.failReplace; this.replaces.push(md); }
	async listComments() { this.chk(); return [...this.comments]; }
	async addComment(_id: string, body: string) {
		this.chk();
		const id = `c${this.seq + 1}`;
		this.comments.push({ id, author_id: BOT, body, created_at: this.stamp(), thread_id: id, parent_id: null });
		return { id, thread_id: id };
	}
	reply(threadId: string, body: string, author: string | null = OWNER) {
		const id = `c${this.seq + 1}`;
		this.comments.push({ id, author_id: author, body, created_at: this.stamp(), thread_id: threadId, parent_id: threadId });
	}
	comment(body: string, author: string | null = OWNER) {
		const id = `c${this.seq + 1}`;
		this.comments.push({ id, author_id: author, body, created_at: this.stamp(), thread_id: id, parent_id: null });
	}
}

export function fakePi(entries: any[] = [], settings: any = {}) {
	const handlers = new Map<string, Array<(e: any, c: any) => any>>();
	const listeners = new Map<string, Array<(p: any) => void>>();
	const h = {
		tools: new Map<string, any>(), commands: new Map<string, any>(), entries, sent: [] as { text: string; opts: any }[],
		notes: [] as string[], status: [] as (string | undefined)[], settings, sendThrows: false, throwOnAppend: false,
		fleet: { entries: [] as any[], totalActive: 0 } as any, snapshot: undefined as any, cost: undefined as any,
		pi: undefined as any,
		ctx: (over: any = {}) => ({
			mode: "tui", model: { provider: "claude-bridge", id: "opus" }, cwd: "/work/demo",
			sessionManager: { getBranch: () => entries, getSessionName: () => undefined },
			ui: { notify: (m: string) => h.notes.push(m), setStatus: (_k: string, t?: string) => h.status.push(t) }, ...over,
		}),
		fire: async (ev: string, e: any = {}, c?: any) => { for (const f of handlers.get(ev) ?? []) await f(e, c ?? h.ctx()); },
		handlerCount: () => [...handlers.values()].reduce((n, a) => n + a.length, 0),
	};
	h.pi = {
		on: (ev: string, fn: any) => { (handlers.get(ev) ?? handlers.set(ev, []).get(ev)!).push(fn); },
		registerTool: (t: any) => h.tools.set(t.name, t),
		registerCommand: (n: string, c: any) => h.commands.set(n, c),
		appendEntry: (type: string, data: any) => { if (h.throwOnAppend) throw new Error("disk full"); entries.push({ type: "custom", customType: type, data: structuredClone(data) }); },
		sendUserMessage: (text: string, opts: any) => { if (h.sendThrows) throw new Error("rejected"); h.sent.push({ text, opts }); },
		getSettings: () => h.settings,
		events: {
			on: (ev: string, fn: any) => { (listeners.get(ev) ?? listeners.set(ev, []).get(ev)!).push(fn); return () => { listeners.set(ev, (listeners.get(ev) ?? []).filter((x) => x !== fn)); }; },
			emit: (ev: string, p: any) => { for (const f of [...(listeners.get(ev) ?? [])]) f(p); },
		},
	};
	// stands in for the pi-subagents extension answering RPC status requests
	h.pi.events.on("subagents:rpc:v1:request", (req: any) => {
		const data = req.method === "cost" ? h.cost : { fleet: h.fleet, asyncSnapshot: h.snapshot };
		if (data !== undefined) h.pi.events.emit(`subagents:rpc:v1:reply:${req.requestId}`, { version: 1, requestId: req.requestId, success: true, data });
	});
	return h;
}

export function harness(o: { settings?: any; env?: Record<string, string>; entries?: any[]; knot?: FakeKnot } = {}) {
	const knot = o.knot ?? new FakeKnot();
	const settings = o.settings ?? { "pi-knot-headless": { url: "https://knot.example.com", parentPageId: PARENT, ownerUid: OWNER } };
	const h = fakePi(o.entries ?? [], settings);
	const clock = { t: Date.UTC(2026, 10, 21, 10, 0) };
	const timeouts: Array<() => void> = [];
	const intervals: unknown[] = [];
	const deps: Deps = {
		now: () => clock.t, env: { KNOT_TOKEN: "tok-123456789", ...(o.env ?? {}) }, settings: () => settings["pi-knot-headless"],
		makeKnot: () => knot, setInterval: (fn) => { intervals.push(fn); return fn; }, clearInterval: () => {},
		setTimeout: (fn) => { timeouts.push(fn); return fn; }, sleep: () => new Promise(() => {}), log: () => {}, paramsSchema: {}, tz: "UTC",
	};
	const handle: Handle = create(h.pi, deps);
	const flush = () => new Promise<void>((r) => setImmediate(r));
	return Object.assign(h, {
		knot, clock, handle, intervals, deps, flush,
		runTimeouts: async () => { const t = timeouts.splice(0); t.forEach((f) => f()); await flush(); await handle.tick(); },
		start: async (reason = "startup", ctx?: any) => h.fire("session_start", { reason }, ctx),
		ask: (p: any, ctx?: any) => h.tools.get("knot_ask").execute("id", p, undefined, undefined, ctx ?? h.ctx()),
	});
}
