import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openAsyncDir, readStepTexts } from "./steptexts.ts";
import { wfDir } from "./fakepi.ts";

test("openAsyncDir accepts only workflow payloads pointing at <tmp>/pi-subagents-*/async-subagent-runs/<id>", () => {
	const { payload, dir } = wfDir(undefined);
	assert.equal(openAsyncDir(payload), dir);
	for (const bad of [undefined, {}, { ...payload, mode: "single" }, { ...payload, asyncDir: "/etc" }, { ...payload, id: "../x" }, { ...payload, id: "other" }, { ...payload, asyncDir: `${dir}/../..` }]) {
		assert.equal(openAsyncDir(bad), undefined, JSON.stringify(bad));
	}
});

test("readStepTexts: keyed by workflowKey else label, agent prefix removed, bounded, never throws", () => {
	const long = "x".repeat(500);
	const { dir } = wfDir({ steps: [
		{ agent: "explorer", label: "task-1", sessionName: "explorer: find the parser" },
		{ agent: "coder", workflowKey: "pass2", label: "ignored", sessionName: `coder: ${long}` },
		{ agent: "coder", label: "bare", sessionName: "coder" }, // no excerpt: nothing to show
		{ agent: "coder", sessionName: "coder: no key" },
		{ label: "no-agent", sessionName: "  spaced \n out " },
	] });
	const m = readStepTexts(dir);
	assert.equal(m.get("task-1"), "find the parser");
	assert.equal(m.get("pass2")!.length, 200);
	assert.equal(m.get("no-agent"), "spaced out");
	assert.deepEqual([...m.keys()].sort(), ["no-agent", "pass2", "task-1"]);
	assert.equal(readStepTexts(wfDir("{not json").dir).size, 0);
	assert.equal(readStepTexts(wfDir(undefined).dir).size, 0);
	assert.equal(readStepTexts(wfDir({ steps: "nope" }).dir).size, 0);
	assert.equal(readStepTexts(wfDir(`{"steps":[],"pad":"${"x".repeat(2_100_000)}"}`).dir).size, 0); // oversized
	const l = wfDir(undefined);
	writeFileSync(join(l.dir, "real.json"), JSON.stringify({ steps: [{ agent: "a", label: "k", sessionName: "a: secret from a symlink" }] }));
	symlinkSync(join(l.dir, "real.json"), join(l.dir, "status.json"));
	assert.equal(readStepTexts(l.dir).size, 0);
});
