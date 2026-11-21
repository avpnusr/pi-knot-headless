import test from "node:test";
import assert from "node:assert/strict";
import { createKnot, tokenVarFor, KnotAuthError } from "./knot.ts";

type Call = { url: string; init: RequestInit };
function fake(responses: Array<Response | Error>) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const f = async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const r = responses.shift() ?? new Response("", { status: 204 });
		if (r instanceof Error) throw r;
		return r;
	};
	const knot = createKnot({ fetch: f as typeof fetch, baseUrl: "https://knot.example.com", token: () => "TOKEN-123456", sleep: async (ms) => void sleeps.push(ms) });
	return { knot, calls, sleeps };
}
const json = (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });

test("createPage / getPage / replace / comments: URLs, methods, headers, bodies", async () => {
	const { knot, calls } = fake([
		json({ id: "p1", created_by: "bot" }, 201), json({ id: "par", created_by: "owner" }), new Response(null, { status: 204 }),
		json([{ id: "c1", author_id: "u", body: "hi", created_at: "2026-01-01T00:00:00Z", thread_id: "c1", parent_id: null }]),
		json({ id: "c2", thread_id: "c2" }, 201),
	]);
	assert.deepEqual(await knot.createPage("T", "parent"), { id: "p1", createdBy: "bot" });
	assert.deepEqual(await knot.getPage("par"), { id: "par", createdBy: "owner" });
	await knot.replace("p1", "# md");
	assert.equal((await knot.listComments("p1"))[0].body, "hi");
	assert.deepEqual(await knot.addComment("p1", "q"), { id: "c2", thread_id: "c2" });

	assert.equal(calls[0].url, "https://knot.example.com/api/docs");
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body as string), { title: "T", parent_id: "parent" });
	assert.equal(calls[1].url, "https://knot.example.com/api/docs/par");
	assert.equal(calls[2].url, "https://knot.example.com/api/docs/p1/markdown?mode=replace");
	assert.equal((calls[2].init.headers as Record<string, string>)["Content-Type"], "text/markdown");
	assert.equal(calls[2].init.body, "# md");
	assert.equal(calls[3].url, "https://knot.example.com/api/docs/p1/comments");
	assert.deepEqual(JSON.parse(calls[4].init.body as string), { body: "q" });
	for (const c of calls) assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer TOKEN-123456");
});

test("429,429,204 -> resolves after sleeping 1s, 2s", async () => {
	const { knot, sleeps, calls } = fake([new Response("", { status: 429 }), new Response("", { status: 429 }), new Response(null, { status: 204 })]);
	await knot.replace("p", "x");
	assert.deepEqual(sleeps, [1000, 2000]);
	assert.equal(calls.length, 3);
});

test("Retry-After is honoured; network errors are retried", async () => {
	const { knot, sleeps } = fake([new Response("", { status: 429, headers: { "retry-after": "3" } }), new TypeError("fetch failed"), new Response(null, { status: 204 })]);
	await knot.replace("p", "x");
	assert.deepEqual(sleeps, [3000, 2000]);
});

test("5 consecutive 500s -> rejects after 5 calls, message has no token", async () => {
	const { knot, calls } = fake(Array.from({ length: 6 }, () => new Response("boom", { status: 500 })));
	await assert.rejects(knot.replace("p", "x"), (e: Error) => !e.message.includes("TOKEN-123456") && /500/.test(e.message));
	assert.equal(calls.length, 5);
});

test("401/403 -> KnotAuthError, no retry; other 4xx -> plain error, no retry", async () => {
	let f = fake([new Response("", { status: 401 })]);
	await assert.rejects(f.knot.replace("p", "x"), KnotAuthError);
	assert.equal(f.calls.length, 1);
	f = fake([new Response("", { status: 403 })]);
	await assert.rejects(f.knot.listComments("p"), KnotAuthError);
	f = fake([new Response("", { status: 404 })]);
	await assert.rejects(f.knot.listComments("p"), (e: Error) => !(e instanceof KnotAuthError));
	assert.equal(f.calls.length, 1);
});

test("403 bot.restricted_forbidden explains the restricted-parent rule", async () => {
	const { knot } = fake([json({ error: { code: "bot.restricted_forbidden" } }, 403)]);
	await assert.rejects(knot.createPage("t", "p"), (e: Error) => e instanceof KnotAuthError && /restricted page/.test(e.message) && /parentPageId/.test(e.message));
});

test("missing token -> KnotAuthError without calling fetch", async () => {
	const calls: unknown[] = [];
	const knot = createKnot({ fetch: (async (...a: unknown[]) => void calls.push(a)) as unknown as typeof fetch, baseUrl: "https://k", token: () => undefined, sleep: async () => {} });
	await assert.rejects(knot.listComments("p"), KnotAuthError);
	assert.equal(calls.length, 0);
});

test("tokenVarFor: exact provider, then '*', else undefined", () => {
	const map = { "claude-bridge": "A", "*": "Z" };
	assert.equal(tokenVarFor("claude-bridge", map), "A");
	assert.equal(tokenVarFor("ollama-cloud", map), "Z");
	assert.equal(tokenVarFor("x", { "claude-bridge": "A" }), undefined);
});
