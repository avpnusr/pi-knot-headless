// Minimal Knot HTTP client. fetch/sleep are injected; secrets never appear in error messages.

export interface Comment {
	id: string;
	author_id: string | null;
	body: string;
	created_at: string;
	thread_id: string;
	parent_id: string | null;
}
export interface Knot {
	createPage(title: string, parentId: string): Promise<{ id: string; createdBy: string }>;
	replace(pageId: string, markdown: string): Promise<void>;
	listComments(pageId: string): Promise<Comment[]>;
	addComment(pageId: string, body: string): Promise<{ id: string; thread_id: string }>;
}
export class KnotAuthError extends Error {}

export function tokenVarFor(provider: string, map: Record<string, string>): string | undefined {
	return map[provider] ?? map["*"];
}

const DELAYS = [1000, 2000, 4000, 8000];
const REQUEST_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createKnot(o: {
	fetch: typeof fetch;
	baseUrl: string;
	token: () => string | undefined;
	sleep: (ms: number) => Promise<void>;
}): Knot {
	async function call(method: string, path: string, body?: string, contentType?: string): Promise<Response> {
		const token = o.token();
		if (!token) throw new KnotAuthError("no Knot token in the environment (check tokenEnv in the pi-knot-headless settings)");
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (contentType) headers["Content-Type"] = contentType;
		let last = "";
		for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
			let res: Response | undefined;
			try {
				// redirect:"error" so the Authorization header can never follow a redirect to another origin
				res = await o.fetch(`${o.baseUrl}${path}`, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			} catch (e) {
				last = `network error: ${(e as Error).message}`;
			}
			if (res) {
				if (res.ok) return res;
				if (res.status === 401 || res.status === 403) {
					const raw = await res.json().then((j: any) => j?.error?.code as unknown).catch(() => undefined);
					const code = typeof raw === "string" && /^[\w.-]{1,64}$/.test(raw) ? raw : undefined;
					if (code === "bot.restricted_forbidden") {
						throw new KnotAuthError("Knot bots may not create pages below a restricted page (bot.restricted_forbidden). Set parentPageId to an unrestricted page.");
					}
					throw new KnotAuthError(`Knot rejected the token (HTTP ${res.status}${code ? `, ${code}` : ""})`);
				}
				if (res.status !== 429 && res.status < 500) throw new Error(`Knot ${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
				last = `HTTP ${res.status}`;
				if (attempt < DELAYS.length) {
					const ra = Number(res.headers.get("retry-after"));
					await o.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : DELAYS[attempt]);
				}
				continue;
			}
			if (attempt < DELAYS.length) await o.sleep(DELAYS[attempt]);
		}
		throw new Error(`Knot ${method} ${path.split("?")[0]} failed after retries: ${last}`);
	}
	const j = async (r: Response) => (await r.json()) as Record<string, any>;

	return {
		async createPage(title, parentId) {
			const r = await j(await call("POST", "/api/docs", JSON.stringify({ title, parent_id: parentId }), "application/json"));
			if (typeof r.id !== "string" || !UUID.test(r.id)) throw new Error("Knot answered with an unexpected page id");
			return { id: r.id, createdBy: String(r.created_by ?? "") };
		},
		async replace(pageId, markdown) {
			await call("POST", `/api/docs/${pageId}/markdown?mode=replace`, markdown, "text/markdown");
		},
		async listComments(pageId) {
			return (await (await call("GET", `/api/docs/${pageId}/comments?include_resolved=true`)).json()) as Comment[];
		},
		async addComment(pageId, body) {
			const r = await j(await call("POST", `/api/docs/${pageId}/comments`, JSON.stringify({ body }), "application/json"));
			return { id: r.id, thread_id: r.thread_id };
		},
	};
}
