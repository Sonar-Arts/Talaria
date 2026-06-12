import type { ChatMessage, Idea, IssueRef, Proposal } from "../types";
import { editNoteContentPlaceholder } from "./json-utils";

const ISSUE_BODY_TRUNCATE = 600;
const VAULT_LIST_MAX_ENTRIES = 300;
const VAULT_LIST_MAX_CHARS = 8000;

export function issueDigest(issues: IssueRef[]): string {
	if (issues.length === 0) return "(no open issues)";
	return issues
		.map((i) => {
			const labels = i.labels.length ? ` [${i.labels.join(", ")}]` : "";
			const body = i.body
				? "\n" +
					(i.body.length > ISSUE_BODY_TRUNCATE
						? i.body.slice(0, ISSUE_BODY_TRUNCATE) + "…"
						: i.body)
				: "";
			return `#${i.number}${labels} ${i.title}${body}`;
		})
		.join("\n---\n");
}

export function ideaDigest(ideas: Idea[]): string {
	return JSON.stringify(
		ideas.map((i) => ({
			id: i.id,
			title: i.title,
			summary: i.summary,
			category: i.category,
			sourceNotes: i.sourceNotes,
		})),
		null,
		1
	);
}

// ---------- Phase A: extract ideas ----------

export function extractIdeasMessages(noteChunk: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `You extract actionable ideas from a user's personal notes. An idea is anything that could become work: a feature, a bug to fix, an improvement, a question to research, a documentation need.

Rules:
- Extract every distinct idea. Merge near-duplicates within this input.
- Ignore journaling, fluff, and things that are clearly not actionable.
- "category" is a short lowercase word like: feature, bug, docs, refactor, research, chore.
- "sourceNote" is the note path the idea came from (shown in === NOTE: path === headers).

Output ONLY a JSON array, no prose, no markdown fences:
[{"title": "short imperative title", "summary": "2-4 sentence summary in the user's intent", "category": "feature", "sourceNote": "path/to/note.md"}]
If there are no ideas, output [].`,
		},
		{ role: "user", content: noteChunk },
	];
}

export function dedupeIdeasMessages(ideas: Idea[]): ChatMessage[] {
	return [
		{
			role: "system",
			content: `You merge duplicate ideas in a list. Combine items that describe the same underlying idea: keep the clearest title, merge summaries, union sourceNotes. Keep distinct ideas untouched.

Output ONLY a JSON array in the same schema, no prose:
[{"title": "...", "summary": "...", "category": "...", "sourceNotes": ["path.md"]}]`,
		},
		{ role: "user", content: ideaDigest(ideas) },
	];
}

// ---------- Phase B: match & propose ----------

export function proposeActionsMessages(
	ideas: Idea[],
	issues: IssueRef[],
	labels: string[],
	repo: string
): ChatMessage[] {
	return [
		{
			role: "system",
			content: `You triage a user's ideas against the open GitHub issues of ${repo}. For EACH idea decide:
- It is NOT covered by any open issue → propose "create_issue".
- It matches an existing issue and adds new thinking → propose "comment" on that issue (preferred over editing, keeps history), or "edit_issue" if the issue body/title is genuinely wrong or incomplete.
- It matches an existing issue with nothing to add → no proposal for that idea.
- Optionally propose "set_labels" to fix categorization of an issue.

Available labels (use ONLY these, never invent labels): ${labels.length ? labels.join(", ") : "(none)"}

Issue bodies you write should be well-structured markdown: a short problem/idea statement, then details. Mention the source note paths at the bottom as "Source notes: ...".

Output ONLY this JSON, no prose, no markdown fences:
{"proposals": [
 {"id": "new", "kind": "create_issue", "title": "...", "body": "...", "labels": ["..."], "rationale": "one sentence why", "sourceIdeaIds": ["i1"]},
 {"id": "new", "kind": "comment", "number": 14, "body": "...", "rationale": "...", "sourceIdeaIds": ["i2"]},
 {"id": "new", "kind": "edit_issue", "number": 7, "title": "optional", "body": "optional full replacement body", "rationale": "...", "sourceIdeaIds": ["i3"]},
 {"id": "new", "kind": "set_labels", "number": 7, "add": ["bug"], "remove": [], "rationale": "...", "sourceIdeaIds": []}
]}
If no actions are warranted, output {"proposals": []}.`,
		},
		{
			role: "user",
			content: `IDEAS:\n${ideaDigest(ideas)}\n\nOPEN ISSUES:\n${issueDigest(issues)}`,
		},
	];
}

// ---------- Chat ----------

function vaultPathsDigest(vaultPaths: string[]): string {
	if (vaultPaths.length === 0) return "(none)";
	const lines: string[] = [];
	let chars = 0;
	for (const p of vaultPaths) {
		if (lines.length >= VAULT_LIST_MAX_ENTRIES || chars + p.length > VAULT_LIST_MAX_CHARS) {
			lines.push(`…and ${vaultPaths.length - lines.length} more — other vault paths may still be requested`);
			break;
		}
		lines.push(p);
		chars += p.length + 1;
	}
	return lines.join("\n");
}

export function chatSystemPrompt(
	ideas: Idea[],
	issues: IssueRef[],
	labels: string[],
	proposals: Proposal[],
	repo: string,
	vaultPaths: string[]
): string {
	const proposalJson = JSON.stringify(
		proposals
			.filter((p) => p.status !== "applied")
			.map((p) => ({
				id: p.id,
				status: p.status,
				userEdited: p.userEdited,
				rationale: p.rationale,
				sourceIdeaIds: p.sourceIdeaIds,
				...p.action,
				// Don't round-trip long note contents through every turn.
				...(p.action.kind === "edit_note"
					? { content: editNoteContentPlaceholder(p.action.content.length) }
					: {}),
			})),
		null,
		1
	);
	return `You are an assistant inside an Obsidian plugin helping the user refine proposed GitHub issue changes for ${repo} before they are applied, and to edit the user's own markdown notes when asked. You and the user are looking at the same proposal list.

CONTEXT — ideas extracted from the user's notes:
${ideaDigest(ideas)}

CONTEXT — open issues:
${issueDigest(issues)}

Available labels (never invent others): ${labels.length ? labels.join(", ") : "(none)"}

VAULT NOTES (markdown files you may read and propose edits to — never invent paths):
${vaultPathsDigest(vaultPaths)}

CURRENT PROPOSALS (statuses reflect the user's review so far; "applied" items are already on GitHub and immutable):
${proposalJson}

READING NOTES:
To edit a note you MUST first see its current content. If it is not already in this conversation, reply with ONLY a fenced block listing the paths (max 5), then wait for the contents:
\`\`\`read
path/to/note.md
\`\`\`
Never combine a read block with a proposals block in the same reply. If a note came back truncated, tell the user it is too large to edit safely instead of proposing an edit.

HOW TO RESPOND:
- Reply conversationally and concisely. Refer to proposals by their id (e.g. p2).
- If and ONLY if the user's message warrants changing the proposals, ALSO include after your prose exactly one fenced block:
\`\`\`proposals
{"proposals": [ ...the COMPLETE revised list... ]}
\`\`\`
- The block must contain EVERY remaining proposal, echoing unchanged ones verbatim including their "id". Use "id": "new" for additions. Omit a proposal to delete it.
- Each item is flat: {"id", "kind", "rationale", "sourceIdeaIds", and the fields for its kind: create_issue→title/body/labels, edit_issue→number/title/body, comment→number/body, set_labels→number/add/remove, edit_note→path/content}.
- For edit_note, "content" is the COMPLETE new markdown for the note — preserve every section you are not changing; never drop content silently. When echoing an UNCHANGED edit_note, omit its "content" field entirely (the plugin keeps the current value).
- Do not include applied proposals in the block.
- Never emit the block if nothing should change.`;
}
