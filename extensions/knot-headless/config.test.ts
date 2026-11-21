import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";

const U1 = "11111111-2222-3333-4444-555555555555";
const U2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const base = { url: "https://knot.example.com/", parentPageId: U1 };

test("valid minimal config gets defaults, trailing slash stripped", () => {
	const r = loadConfig(base, {});
	assert.ok(r.ok);
	assert.equal(r.cfg.url, "https://knot.example.com");
	assert.deepEqual(r.cfg.tokenEnv, { "*": "KNOT_TOKEN" });
	assert.equal(r.cfg.askTimeoutMinutes, 120);
	assert.equal(r.cfg.enabled, true);
	assert.deepEqual(r.cfg.secretEnv, []);
	assert.equal(r.cfg.ownerUid, undefined);
});

test("env overrides settings", () => {
	const r = loadConfig(base, { KNOT_URL: "https://other.example.org", KNOT_PARENT_PAGE_ID: U2, KNOT_OWNER_UID: U1 });
	assert.ok(r.ok);
	assert.equal(r.cfg.url, "https://other.example.org");
	assert.equal(r.cfg.parentPageId, U2);
	assert.equal(r.cfg.ownerUid, U1);
});

test("missing or invalid keys name the key", () => {
	for (const [s, key] of [
		[{ parentPageId: U1 }, "url"],
		[{ url: "https://x.example" }, "parentPageId"],
		[{ ...base, parentPageId: "nope" }, "parentPageId"],
		[{ ...base, ownerUid: "nope" }, "ownerUid"],
		[{ ...base, askTimeoutMinutes: -1 }, "askTimeoutMinutes"],
		[{ ...base, tokenEnv: { "*": "bad name" } }, "tokenEnv"],
		[null, "url"],
	] as const) {
		const r = loadConfig(s, {});
		assert.ok(!r.ok, key);
		assert.ok(r.reason.includes(key), `${r.reason} should mention ${key}`);
	}
});

test("url scheme: http only for localhost", () => {
	assert.ok(!loadConfig({ ...base, url: "http://evil.com" }, {}).ok);
	assert.ok(loadConfig({ ...base, url: "http://localhost:3000" }, {}).ok);
	assert.ok(!loadConfig({ ...base, url: "ftp://x" }, {}).ok);
});

test("enabled:false is honoured", () => {
	const r = loadConfig({ ...base, enabled: false }, {});
	assert.ok(r.ok);
	assert.equal(r.cfg.enabled, false);
});
