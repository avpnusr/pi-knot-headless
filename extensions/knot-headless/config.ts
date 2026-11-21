// Reads the "pi-knot-headless" block of pi's settings.json; env vars override the connection keys.

export interface Config {
	url: string;
	parentPageId: string;
	ownerUid: string;
	tokenEnv: Record<string, string>;
	secretEnv: string[];
	askTimeoutMinutes: number;
	enabled: boolean;
	/** Present only when the user opted in; there is no default model. */
	summarizer?: { model: string; title: boolean };
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
	if (u.username || u.password || u.search || u.hash || url.includes("?") || url.includes("#")) return bad("url", "must not contain credentials, a query or a fragment");

	const parentPageId = env.KNOT_PARENT_PAGE_ID ?? s.parentPageId;
	if (typeof parentPageId !== "string" || !UUID.test(parentPageId)) return bad("parentPageId", "must be a UUID (or env KNOT_PARENT_PAGE_ID)");

	const ownerUid = env.KNOT_OWNER_UID ?? s.ownerUid;
	if (typeof ownerUid !== "string" || !UUID.test(ownerUid)) return bad("ownerUid", "is required: the Knot user id (UUID) whose comments may steer the session (or env KNOT_OWNER_UID)");

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
	if (typeof askTimeoutMinutes !== "number" || !Number.isFinite(askTimeoutMinutes) || askTimeoutMinutes <= 0 || askTimeoutMinutes > 525_600) return bad("askTimeoutMinutes", "must be a number between 1 and 525600");

	let summarizer: Config["summarizer"];
	if (s.summarizer !== undefined) {
		const z = s.summarizer;
		if (!z || typeof z !== "object" || Array.isArray(z)) return bad("summarizer", "must be an object { enabled, model, title }");
		const o = z as Record<string, unknown>;
		if (o.title !== undefined && typeof o.title !== "boolean") return bad("summarizer", "title must be true or false");
		if (o.enabled === true) {
			if (typeof o.model !== "string" || !/^[^/\s]+\/\S+$/.test(o.model)) return bad("summarizer", "needs a model as \"provider/id\" when enabled (there is no default: you choose where session metadata is sent)");
			summarizer = { model: o.model, title: o.title === true };
		}
	}
	return {
		ok: true,
		cfg: {
			url: url.replace(/\/+$/, ""),
			parentPageId,
			ownerUid,
			tokenEnv,
			secretEnv: secretEnv as string[],
			askTimeoutMinutes,
			enabled: s.enabled !== false,
			...(summarizer ? { summarizer } : {}),
		},
	};
}
