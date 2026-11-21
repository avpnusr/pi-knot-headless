// Reads the "pi-knot-headless" block of pi's settings.json; env vars override the connection keys.

export interface Config {
	url: string;
	parentPageId: string;
	ownerUid?: string;
	tokenEnv: Record<string, string>;
	secretEnv: string[];
	askTimeoutMinutes: number;
	enabled: boolean;
}
export type ConfigResult = { ok: true; cfg: Config } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bad = (key: string, why: string): ConfigResult => ({ ok: false, reason: `pi-knot-headless: "${key}" ${why}` });

export function loadConfig(settings: unknown, env: Record<string, string | undefined>): ConfigResult {
	const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
	const url = env.KNOT_URL ?? s.url;
	if (typeof url !== "string" || !url) return bad("url", "is required (Knot base URL, or env KNOT_URL)");
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return bad("url", "is not a valid URL");
	}
	const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
	if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return bad("url", "must be https (http only for localhost)");

	const parentPageId = env.KNOT_PARENT_PAGE_ID ?? s.parentPageId;
	if (typeof parentPageId !== "string" || !UUID.test(parentPageId)) return bad("parentPageId", "must be a UUID (or env KNOT_PARENT_PAGE_ID)");

	const ownerUid = env.KNOT_OWNER_UID ?? s.ownerUid;
	if (ownerUid !== undefined && (typeof ownerUid !== "string" || !UUID.test(ownerUid))) return bad("ownerUid", "must be a UUID");

	let tokenEnv: Record<string, string> = { "*": "KNOT_TOKEN" };
	if (s.tokenEnv !== undefined) {
		const t = s.tokenEnv;
		if (!t || typeof t !== "object" || Array.isArray(t)) return bad("tokenEnv", "must be an object provider -> ENV_VAR_NAME");
		for (const v of Object.values(t)) if (typeof v !== "string" || !ENV_NAME.test(v)) return bad("tokenEnv", "values must be environment variable names");
		tokenEnv = t as Record<string, string>;
	}
	const secretEnv = s.secretEnv ?? [];
	if (!Array.isArray(secretEnv) || secretEnv.some((n) => typeof n !== "string")) return bad("secretEnv", "must be an array of env var names");

	const askTimeoutMinutes = s.askTimeoutMinutes ?? 120;
	if (typeof askTimeoutMinutes !== "number" || !(askTimeoutMinutes > 0)) return bad("askTimeoutMinutes", "must be a positive number");

	return {
		ok: true,
		cfg: {
			url: url.replace(/\/+$/, ""),
			parentPageId,
			ownerUid: ownerUid as string | undefined,
			tokenEnv,
			secretEnv: secretEnv as string[],
			askTimeoutMinutes,
			enabled: s.enabled !== false,
		},
	};
}
