// Task text of workflow workers that never went through our launch args (scripted workflows): pi-subagents writes each step's
// `sessionName` ("<agent>: <task excerpt>") into <asyncDir>/status.json even though it redacts the task itself.
// Read-only and bounded; a changed layout just means the row keeps its step label.
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const MAX_FILE = 2 * 1024 * 1024; // real files are ~40 KB
const MAX_STEPS = 64;
const MAX_TEXT = 200;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Only `<tmp>/pi-subagents-<uid>/async-subagent-runs/<id>` of an async-started payload is ever read.
export function openAsyncDir(p: any): string | undefined {
	if (p?.mode !== "workflow" || typeof p?.id !== "string" || !SAFE_ID.test(p.id) || typeof p?.asyncDir !== "string") return undefined;
	const dir = resolve(p.asyncDir);
	if (basename(dir) !== p.id || basename(dirname(dir)) !== "async-subagent-runs" || !basename(dirname(dirname(dir))).startsWith("pi-subagents")) return undefined;
	return dir;
}

/** step key (workflowKey, else label) -> task excerpt. Never throws. */
export function readStepTexts(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const f = resolve(dir, "status.json");
		const s = lstatSync(f);
		if (!s.isFile() || s.size > MAX_FILE) return out;
		const steps = JSON.parse(readFileSync(f, "utf8"))?.steps;
		for (const st of Array.isArray(steps) ? steps.slice(0, MAX_STEPS) : []) {
			const key = typeof st?.workflowKey === "string" ? st.workflowKey : typeof st?.label === "string" ? st.label : undefined;
			const agent = typeof st?.agent === "string" ? st.agent : "";
			let text = typeof st?.sessionName === "string" ? st.sessionName.replace(/\s+/g, " ").trim() : "";
			if (agent && text.startsWith(`${agent}: `)) text = text.slice(agent.length + 2);
			if (key && text && text !== agent) out.set(key, text.slice(0, MAX_TEXT));
		}
	} catch { /* missing, half-written or foreign file: no texts */ }
	return out;
}
