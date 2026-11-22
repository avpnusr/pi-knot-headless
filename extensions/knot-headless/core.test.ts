import test from "node:test";
import assert from "node:assert/strict";
import { isInert, redact, secretValuesFromEnv, looksLikeAsk, mirrorChatAsk, newState, pickResolvable, elide, askTail } from "./core.ts";

test("isInert: subagent children and non-interactive modes", () => {
	assert.equal(isInert({ PI_SUBAGENT_CHILD: "1" }, "tui"), true);
	assert.equal(isInert({ PI_SUBAGENT_RUNNER_PID: "42" }, "tui"), true);
	assert.equal(isInert({}, "print"), true);
	assert.equal(isInert({}, "json"), true);
	assert.equal(isInert({}, undefined), true);
	assert.equal(isInert({}, "tui"), false);
	assert.equal(isInert({}, "rpc"), false);
});

test("redact: secret values and token patterns", () => {
	const secret = "s3cr3t-value-123";
	const text = `a ${secret} b knot_abc123def456 c Bearer abc.def d sk-AAAAAAAAAAAAAAAA e ghp_AAAAAAAAAAAAAAAAAAAA f\n-----BEGIN PRIVATE KEY-----`;
	const out = redact(text, [secret]);
	for (const bad of [secret, "knot_abc123def456", "abc.def", "sk-AAAA", "ghp_AAAA", "BEGIN PRIVATE KEY"]) {
		assert.ok(!out.includes(bad), `still contains ${bad}`);
	}
	assert.ok(out.includes("[redacted]"));
});

test("redact: a whole PEM block, AWS/Slack/Google keys", () => {
	const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQyNTUxOQAAACD\n-----END OPENSSH PRIVATE KEY-----";
	const out = redact(`k: ${pem} after AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abcdef AIzaSyA-1234567890abcdefghijk`, []);
	for (const bad of ["b3BlbnNzaC1", "QyNTUx", "AKIAABCDEFGH", "xoxb-1234", "AIzaSyA-"]) assert.ok(!out.includes(bad), bad);
	assert.ok(out.includes("after"));
	assert.ok(redact("-----BEGIN PRIVATE KEY-----\nabcdef", []).indexOf("abcdef") < 0); // unterminated block: cut to the end
});

test("redact: GitHub fine-grained PAT, Stripe, GitLab, npm tokens", () => {
	const out = redact(`a github_pat_${"A".repeat(30)} b rk_live_${"A".repeat(24)} c sk_test_${"A".repeat(24)} d glpat-${"A".repeat(24)} e npm_${"A".repeat(36)} f`, []);
	for (const bad of ["github_pat_", "rk_live_", "sk_test_", "glpat-", "npm_"]) assert.ok(!out.includes(bad), `still contains ${bad}`);
	assert.ok(out.includes("[redacted]"));
});

test("redact: normal text untouched; secret chars are not a regex", () => {
	assert.equal(redact("hello world, task 42", []), "hello world, task 42");
	assert.equal(redact("x a.b*c+d y", ["a.b*c+d"]), "x [redacted] y");
});

test("secretValuesFromEnv: only named vars, values >= 8 chars", () => {
	const env = { A_TOKEN: "12345678", B_TOKEN: "1234567", C: "longenoughvalue", EMPTY: "" };
	assert.deepEqual(secretValuesFromEnv(env, ["A_TOKEN", "B_TOKEN", "EMPTY", "MISSING"]), ["12345678"]);
});

test("looksLikeAsk: questions and gates in the last paragraph, not plain reports", () => {
	for (const t of ["Shall I push it?", "Done.\n\nTell me if you want me to push it.", "Which one do you prefer? **A** or B?**", "Please confirm before I continue.", "I need your go-ahead to delete the branch."]) assert.equal(looksLikeAsk(t), true, t);
	for (const t of ["", "   ", "All 200 tests pass.", "Is it done? Yes.\n\nThe release is committed.", "Fixed the bug in core.ts."]) assert.equal(looksLikeAsk(t), false, t);
});

test("mirrorChatAsk: opens a critical, mirrored question built from the tail of the message and logs it", () => {
	const s = newState(1, "t", "m");
	const long = `${"x".repeat(500)} Should I push the release?`;
	const r = mirrorChatAsk(s, long, 5);
	assert.equal(r.qid, "Q1");
	const q = r.state.questions[0];
	assert.equal(q.severity, "critical");
	assert.equal(q.deadline, undefined);
	assert.equal(q.mirrored, true);
	assert.ok(q.text.endsWith("Should I push the release?"));
	assert.ok(q.text.length < 240);
	assert.equal(r.state.decisions.length, 0, "the question itself is the record; no extra system line on the page");
});

test("askTail: the last paragraph, whole trailing sentences, never a mid-sentence start", () => {
	assert.equal(askTail("Tests pass. Docs are updated.\n\nShall I push it?"), "Shall I push it?", "last paragraph only");
	assert.equal(askTail("  One\nline   with\tspaces?  "), "One line with spaces?");
	const para = `${"A filler sentence about something else. ".repeat(10)}The release is ready. Shall I push it?`;
	const t0 = askTail(para);
	assert.ok(t0.length <= 200 && t0.startsWith("A filler sentence") && t0.endsWith("The release is ready. Shall I push it?"), "as many trailing whole sentences as fit, starting at a sentence boundary");
	assert.ok(t0.split(". ").every((x) => x.length === 0 || /^[A-Z]/.test(x)), "no sentence is cut");
	assert.equal(askTail("See https://a.b/c and a.b now. Want me to go on?"), "See https://a.b/c and a.b now. Want me to go on?", "dots inside words and URLs are not sentence ends");
	const huge = `${"word ".repeat(80)}and finally: should I push?`;
	const t = askTail(huge);
	assert.ok(t.startsWith("…") && t.endsWith("should I push?") && t.length <= 201, t);
	assert.match(t, /^…(word|and|finally:) /, "cut at a word boundary");
	assert.equal(askTail(""), "");
});

const cm = (id: string, sec: number, thread = id, parent: string | null = null, resolved: string | null = null) => ({
	id, author_id: "u", body: "", created_at: `2026-11-21T10:00:${String(sec).padStart(2, "0")}.000000Z`, thread_id: thread, parent_id: parent, resolved_at: resolved,
});
const WM = { id: "z", createdAt: "2026-11-21T10:00:50.000000Z" }; // everything below second 50 is delivered
const none = new Set<string>();

test("pickResolvable: keeps the newest 5 threads, picks the oldest finished ones, at most `max`", () => {
	const all = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => cm(`t${n}`, n));
	assert.deepEqual(pickResolvable(all, WM, [], none), ["t1", "t2", "t3"]);
	assert.deepEqual(pickResolvable(all, WM, [], none, 5, 2), ["t1", "t2"]);
	assert.deepEqual(pickResolvable(all.slice(0, 5), WM, [], none), [], "five threads: nothing to clean");
});

test("pickResolvable: ranks by latest activity, so an answered old thread stays", () => {
	const all = [cm("t1", 1), cm("r1", 20, "t1", "t1"), ...[2, 3, 4, 5, 6, 7].map((n) => cm(`t${n}`, n))];
	// t1 has the newest activity (second 20): it is kept, t2..t4 are the oldest of the rest
	assert.deepEqual(pickResolvable(all, WM, [], none), ["t2", "t3"]);
});

test("pickResolvable: never an undelivered thread, an open question's thread, a resolved or skipped one", () => {
	const old = [1, 2, 3, 4].map((n) => cm(`t${n}`, n));
	const fresh = [5, 6, 7, 8, 9].map((n) => cm(`t${n}`, n));
	assert.deepEqual(pickResolvable([...old, ...fresh], WM, ["t1"], new Set(["t2"])), ["t3", "t4"], "open + skipped excluded");
	assert.deepEqual(pickResolvable([cm("t1", 1, "t1", null, "2026-11-21T10:00:09.000000Z"), ...old.slice(1), ...fresh], WM, [], none), ["t2", "t3", "t4"], "already resolved excluded");
	const wmEarly = { id: "z", createdAt: "2026-11-21T10:00:02.500000Z" }; // only t1 and t2 delivered
	assert.deepEqual(pickResolvable([...old, ...fresh], wmEarly, [], none), ["t1", "t2"], "t3/t4 are above the watermark");
	const lateReply = [cm("t1", 1), ...[2, 3, 4, 5, 6, 7].map((n) => cm(`t${n}`, n)), cm("r1", 55, "t1", "t1")]; // reply above the watermark
	assert.ok(!pickResolvable(lateReply, WM, [], none).includes("t1"), "a thread with an undelivered reply is not finished");
});

test("elide: up to 1400 chars unchanged, longer keeps head 600 and tail 800 around an ellipsis line", () => {
	const t = "a".repeat(1400);
	assert.equal(elide(t), t);
	const long = `${"h".repeat(600)}${"m".repeat(500)}${"t".repeat(800)}`;
	const out = elide(long);
	assert.equal(out, `${"h".repeat(600)}\n…\n${"t".repeat(800)}`);
	assert.ok(!out.includes("m"));
});
