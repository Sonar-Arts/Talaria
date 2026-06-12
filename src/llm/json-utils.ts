import type { ChatMessage, Idea, ModelProposal } from "../types";
import { chatCompletion, ChatCompletionOptions } from "./transport";

/**
 * Pull a JSON value out of LLM output: strips markdown fences, then
 * bracket-scans (string-aware) from the first { or [ to its matching close,
 * applying cheap repairs on parse failure.
 */
export function extractJson(text: string): unknown {
	const candidates: string[] = [];

	const fence = text.match(/```(?:json|proposals)?\s*\n?([\s\S]*?)```/);
	if (fence) candidates.push(fence[1]);

	const scanned = scanBalanced(text);
	if (scanned) candidates.push(scanned);

	candidates.push(text);

	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		try {
			return JSON.parse(trimmed);
		} catch {
			try {
				return JSON.parse(repair(trimmed));
			} catch {
				// try next candidate
			}
		}
	}
	throw new Error("No valid JSON found in the model's reply.");
}

/** Find the first { or [ and return the substring to its matching close. */
function scanBalanced(text: string): string | null {
	const start = text.search(/[{[]/);
	if (start === -1) return null;
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function repair(text: string): string {
	return text
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/,\s*([}\]])/g, "$1");
}

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Validate Phase A output. Broken items are dropped, not fatal. */
export function validateIdeas(data: unknown): Omit<Idea, "id">[] {
	const arr = Array.isArray(data)
		? data
		: data && typeof data === "object" && Array.isArray((data as { ideas?: unknown }).ideas)
			? (data as { ideas: unknown[] }).ideas
			: null;
	if (!arr) throw new Error('Expected a JSON array (or {"ideas": [...]}).');
	const out: Omit<Idea, "id">[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const title = asString(o.title).trim();
		if (!title) continue;
		const sources = asStringArray(o.sourceNotes);
		const single = asString(o.sourceNote).trim();
		if (single) sources.push(single);
		out.push({
			title,
			summary: asString(o.summary).trim(),
			category: asString(o.category, "uncategorized").trim() || "uncategorized",
			sourceNotes: sources,
		});
	}
	return out;
}

const PROPOSAL_KINDS = ["create_issue", "edit_issue", "comment", "set_labels", "edit_note"] as const;

/**
 * Validate the model's proposal list ({"proposals": [...]} or bare array).
 * Items with a bad kind or missing required fields are dropped.
 */
export function validateModelProposals(data: unknown): ModelProposal[] {
	const arr = Array.isArray(data)
		? data
		: data && typeof data === "object" && Array.isArray((data as { proposals?: unknown }).proposals)
			? (data as { proposals: unknown[] }).proposals
			: null;
	if (!arr) throw new Error('Expected {"proposals": [...]} or a JSON array.');
	const out: ModelProposal[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const kind = asString(o.kind) as ModelProposal["kind"];
		if (!PROPOSAL_KINDS.includes(kind)) continue;
		const number =
			typeof o.number === "number"
				? o.number
				: typeof o.number === "string"
					? parseInt(o.number.replace(/^#/, ""), 10)
					: undefined;
		const p: ModelProposal = {
			id: asString(o.id, "new").trim() || "new",
			kind,
			title: typeof o.title === "string" ? o.title : undefined,
			body: typeof o.body === "string" ? o.body : undefined,
			number: number !== undefined && !isNaN(number) ? number : undefined,
			labels: asStringArray(o.labels),
			add: asStringArray(o.add),
			remove: asStringArray(o.remove),
			path: typeof o.path === "string" ? o.path : undefined,
			content: typeof o.content === "string" ? o.content : undefined,
			rationale: asString(o.rationale),
			sourceIdeaIds: asStringArray(o.sourceIdeaIds),
		};
		// Required fields per kind:
		if (p.kind === "create_issue" && !p.title) continue;
		// edit_note may omit "content" (= keep existing); the store enforces it for new items.
		if (p.kind === "edit_note" && !p.path) continue;
		if (p.kind !== "create_issue" && p.kind !== "edit_note" && p.number === undefined) continue;
		if (p.kind === "comment" && !p.body) continue;
		out.push(p);
	}
	return out;
}

/**
 * Split a chat reply into prose and an optional ```proposals block.
 * Falls back to any fenced JSON block containing a "proposals" key.
 */
export function splitProposalsBlock(text: string): { prose: string; block: string | null } {
	const fences = [...text.matchAll(/```(\w*)\s*\n?([\s\S]*?)```/g)];
	for (const m of fences) {
		const lang = m[1].toLowerCase();
		const content = m[2];
		if (lang === "proposals" || ((lang === "json" || lang === "") && /"proposals"\s*:/.test(content))) {
			const prose = (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim();
			return { prose, block: content.trim() };
		}
	}
	// Unfenced fallback: bare JSON object with a "proposals" key at the end.
	if (/"proposals"\s*:/.test(text)) {
		const start = text.indexOf("{");
		if (start !== -1) {
			try {
				extractJson(text.slice(start));
				return { prose: text.slice(0, start).trim(), block: text.slice(start).trim() };
			} catch {
				// not parseable; treat as prose
			}
		}
	}
	return { prose: text.trim(), block: null };
}

/**
 * Placeholder substituted for edit_note content in the chat system prompt so
 * long notes are not round-tripped through every turn. The model is told to
 * omit "content" when echoing an unchanged edit_note; if it echoes the
 * placeholder instead, the store treats that the same as omitted.
 */
export function editNoteContentPlaceholder(chars: number): string {
	return `(unchanged — ${chars} chars; omit this field to keep as-is)`;
}

export function isEditNoteContentPlaceholder(s: string): boolean {
	return /^\(unchanged — \d+ chars; omit this field to keep as-is\)$/.test(s.trim());
}

/**
 * Split a chat reply into prose and an optional ```read block listing vault
 * note paths the model wants to see (one per line; a JSON string array is
 * tolerated). No unfenced fallback — bare paths in prose are too ambiguous.
 */
export function splitReadBlock(text: string): { prose: string; paths: string[] | null } {
	const fences = [...text.matchAll(/```(\w*)\s*\n?([\s\S]*?)```/g)];
	for (const m of fences) {
		if (m[1].toLowerCase() !== "read") continue;
		const content = m[2].trim();
		let paths: string[];
		if (content.startsWith("[")) {
			try {
				const arr = extractJson(content);
				paths = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
			} catch {
				paths = [];
			}
		} else {
			paths = content
				.split("\n")
				.map((line) => line.trim().replace(/^[-*]\s+/, ""))
				.filter((line) => line.length > 0);
		}
		const prose = (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim();
		if (paths.length > 0) return { prose, paths };
	}
	return { prose: text.trim(), paths: null };
}

/**
 * Call the LLM and parse/validate its JSON reply, re-prompting with the
 * error on failure (local models often need one corrective nudge).
 */
export async function withJsonRetry<T>(
	baseOpts: Omit<ChatCompletionOptions, "stream" | "onToken">,
	validate: (data: unknown) => T,
	maxRetries = 2
): Promise<T> {
	const messages = [...baseOpts.messages];
	let lastError = "";
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const reply = await chatCompletion({ ...baseOpts, messages, stream: false });
		try {
			return validate(extractJson(reply));
		} catch (e) {
			lastError = (e as Error).message;
			messages.push({ role: "assistant", content: reply });
			messages.push({
				role: "user",
				content: `Your previous reply was not valid: ${lastError} Reply with ONLY the JSON, no prose, no markdown fences.`,
			} as ChatMessage);
		}
	}
	throw new Error(`The model did not produce valid JSON after ${maxRetries + 1} attempts (${lastError}). A larger or more instruction-tuned model may be needed.`);
}
