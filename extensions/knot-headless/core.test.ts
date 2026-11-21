import test from "node:test";
import assert from "node:assert/strict";
import { isInert, redact, secretValuesFromEnv } from "./core.ts";

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
