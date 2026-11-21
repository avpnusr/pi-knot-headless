// Pure logic: guards, redaction, state reducers, inbox mapping. No I/O.

export function isInert(env: Record<string, string | undefined>, mode: string | undefined): boolean {
	if (env.PI_SUBAGENT_CHILD === "1" || env.PI_SUBAGENT_RUNNER_PID) return true;
	return mode !== "tui" && mode !== "rpc";
}

const SECRET_PATTERNS: RegExp[] = [
	/knot_[A-Za-z0-9]{8,}/g,
	/Bearer\s+\S+/g,
	/\bsk-[A-Za-z0-9_-]{12,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{16,}/g,
	/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	/-----BEGIN [A-Z ]*-----[^\n]*/g,
];

export function redact(text: string, secretValues: string[]): string {
	let out = text;
	for (const v of secretValues) if (v) out = out.split(v).join("[redacted]");
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
}

export function secretValuesFromEnv(env: Record<string, string | undefined>, names: string[]): string[] {
	return names.map((n) => env[n]).filter((v): v is string => typeof v === "string" && v.length >= 8);
}
