/** An idea extracted from the user's notes by the LLM. */
export interface Idea {
	id: string; // "i1", "i2", ... assigned by the plugin
	title: string;
	summary: string;
	category: string; // free-form: "feature", "bug", "docs", ...
	sourceNotes: string[]; // vault paths
}

/** Snapshot of a GitHub issue fetched via gh CLI. */
export interface IssueRef {
	number: number;
	title: string;
	body: string;
	labels: string[];
}

export type ProposalAction =
	| { kind: "create_issue"; title: string; body: string; labels: string[] }
	| { kind: "edit_issue"; number: number; title?: string; body?: string }
	| { kind: "comment"; number: number; body: string }
	| { kind: "set_labels"; number: number; add: string[]; remove: string[] }
	| { kind: "edit_note"; path: string; content: string };

export type ProposalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "applied"
	| "failed";

export interface Proposal {
	id: string; // "p1", "p2", ... assigned by the plugin, never the model
	action: ProposalAction;
	rationale: string;
	sourceIdeaIds: string[];
	status: ProposalStatus;
	userEdited: boolean;
	revision: number;
	history: ProposalAction[];
	/** Badge: the model replaced this proposal's content in a chat revision. */
	revisedByModel?: boolean;
	/** Badge: the model dropped this proposal from its revised list. */
	removedByModel?: boolean;
	/** Issue number created by applying a create_issue action. */
	createdIssueNumber?: number;
	/** File content captured just before an edit_note apply; enables Revert. */
	previousNoteContent?: string;
	/** Badge: an applied edit_note was reverted to its previous content. */
	noteReverted?: boolean;
	error?: string;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** Snapshot of a triage session saved to the plugin data file. */
export interface PersistedSession {
	notePaths: string[];
	ideas: Idea[];
	issues: IssueRef[];
	labels: string[];
	chat: ChatMessage[];
	proposals: Proposal[];
	nextId: number;
}

/** Action shape as the model is asked to emit it (flat, id may be "new"). */
export interface ModelProposal {
	id: string;
	kind: ProposalAction["kind"];
	title?: string;
	body?: string;
	number?: number;
	labels?: string[];
	add?: string[];
	remove?: string[];
	path?: string;
	content?: string;
	rationale?: string;
	sourceIdeaIds?: string[];
}
