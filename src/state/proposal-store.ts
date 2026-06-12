import { Events } from "obsidian";
import type { ModelProposal, Proposal, ProposalAction } from "../types";
import { isEditNoteContentPlaceholder } from "../llm/json-utils";
import { MAX_UNDO_CHARS } from "../vault/note-editor";

function actionFromModel(p: ModelProposal): ProposalAction | null {
	switch (p.kind) {
		case "create_issue":
			if (!p.title) return null;
			return { kind: "create_issue", title: p.title, body: p.body ?? "", labels: p.labels ?? [] };
		case "edit_issue":
			if (p.number === undefined) return null;
			return { kind: "edit_issue", number: p.number, title: p.title, body: p.body };
		case "comment":
			if (p.number === undefined || !p.body) return null;
			return { kind: "comment", number: p.number, body: p.body };
		case "set_labels":
			if (p.number === undefined) return null;
			return { kind: "set_labels", number: p.number, add: p.add ?? [], remove: p.remove ?? [] };
		case "edit_note":
			if (!p.path || p.content === undefined) return null;
			return { kind: "edit_note", path: p.path, content: p.content };
	}
}

function actionsEqual(a: ProposalAction, b: ProposalAction): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Single source of truth for the proposal list. UI re-renders on "changed";
 * chat revisions arrive as a complete replacement list and are diffed by id.
 */
export class ProposalStore extends Events {
	private proposals: Proposal[] = [];
	private nextId = 1;

	all(): readonly Proposal[] {
		return this.proposals;
	}

	get(id: string): Proposal | undefined {
		return this.proposals.find((p) => p.id === id);
	}

	approvedCount(): number {
		return this.proposals.filter((p) => p.status === "approved").length;
	}

	private emit() {
		this.trigger("changed");
	}

	clear() {
		this.proposals = [];
		this.nextId = 1;
		this.emit();
	}

	serialize(): { proposals: Proposal[]; nextId: number } {
		return { proposals: this.proposals, nextId: this.nextId };
	}

	/** Restore from a persisted snapshot (e.g. after a plugin reload). */
	restore(proposals: Proposal[], nextId: number) {
		this.proposals = proposals;
		this.nextId = nextId;
		this.emit();
	}

	/** Seed from the pipeline's Phase B output. */
	seed(modelProposals: ModelProposal[]) {
		this.proposals = [];
		this.nextId = 1;
		for (const mp of modelProposals) {
			const action = actionFromModel(mp);
			if (!action) continue;
			this.proposals.push({
				id: `p${this.nextId++}`,
				action,
				rationale: mp.rationale ?? "",
				sourceIdeaIds: mp.sourceIdeaIds ?? [],
				status: "pending",
				userEdited: false,
				revision: 0,
				history: [],
			});
		}
		this.emit();
	}

	setStatus(id: string, status: Proposal["status"]) {
		const p = this.get(id);
		if (!p || p.status === "applied") return;
		p.status = status;
		if (status !== "rejected") p.removedByModel = false;
		this.emit();
	}

	setAllApproved() {
		for (const p of this.proposals) {
			if (p.status === "pending") p.status = "approved";
		}
		this.emit();
	}

	/** User inline-edited the action's content in the review UI. */
	userEdit(id: string, newAction: ProposalAction) {
		const p = this.get(id);
		if (!p || p.status === "applied") return;
		if (actionsEqual(p.action, newAction)) return;
		p.history.push(p.action);
		p.action = newAction;
		p.userEdited = true;
		p.revisedByModel = false;
		this.emit();
	}

	/** One-click revert to the previous snapshot after a model overwrite. */
	revert(id: string) {
		const p = this.get(id);
		if (!p || p.status === "applied" || p.history.length === 0) return;
		p.action = p.history.pop()!;
		p.revision++;
		p.revisedByModel = false;
		p.userEdited = true;
		this.emit();
	}

	markApplied(id: string, createdIssueNumber?: number, previousNoteContent?: string) {
		const p = this.get(id);
		if (!p) return;
		p.status = "applied";
		p.error = undefined;
		p.noteReverted = false;
		if (createdIssueNumber !== undefined && !isNaN(createdIssueNumber)) {
			p.createdIssueNumber = createdIssueNumber;
		}
		if (previousNoteContent !== undefined && previousNoteContent.length <= MAX_UNDO_CHARS) {
			p.previousNoteContent = previousNoteContent;
		}
		this.emit();
	}

	/** An applied edit_note was written back to its previous content. */
	markNoteReverted(id: string) {
		const p = this.get(id);
		if (!p) return;
		p.previousNoteContent = undefined;
		p.noteReverted = true;
		p.status = "pending";
		this.emit();
	}

	markFailed(id: string, error: string) {
		const p = this.get(id);
		if (!p) return;
		p.status = "failed";
		p.error = error;
		this.emit();
	}

	/**
	 * Apply a complete replacement list from a chat revision.
	 * Returns a summary of what changed for the chat pill.
	 */
	applyModelRevision(modelProposals: ModelProposal[]): {
		added: number;
		changed: number;
		removed: number;
	} {
		const seenIds = new Set<string>();
		let added = 0;
		let changed = 0;
		let removed = 0;

		for (const mp of modelProposals) {
			const existing = mp.id !== "new" ? this.get(mp.id) : undefined;

			// edit_note: an omitted (or placeholder-echoed) content means "unchanged" —
			// inherit it from the existing proposal so long notes need not round-trip.
			if (
				mp.kind === "edit_note" &&
				existing?.action.kind === "edit_note" &&
				(mp.content === undefined || isEditNoteContentPlaceholder(mp.content))
			) {
				mp.content = existing.action.content;
				if (!mp.path) mp.path = existing.action.path;
			}

			const action = actionFromModel(mp);
			if (!action) continue;

			if (existing) {
				seenIds.add(existing.id);
				if (existing.status === "applied") continue; // immutable
				if (actionsEqual(existing.action, action)) {
					// Unchanged content: keep status/approval as-is, maybe update rationale.
					if (mp.rationale) existing.rationale = mp.rationale;
					// Model re-listed something it previously removed: resurrect it.
					if (existing.removedByModel) {
						existing.removedByModel = false;
						existing.status = "pending";
						changed++;
					}
					continue;
				}
				const wasUserEdited = existing.userEdited;
				existing.history.push(existing.action);
				existing.action = action;
				if (mp.rationale) existing.rationale = mp.rationale;
				if (mp.sourceIdeaIds?.length) existing.sourceIdeaIds = mp.sourceIdeaIds;
				existing.revision++;
				existing.status = "pending"; // changed content must be re-approved
				existing.revisedByModel = true;
				existing.userEdited = wasUserEdited; // drives the "your edit was replaced" badge
				existing.removedByModel = false;
				existing.noteReverted = false;
				changed++;
			} else {
				this.proposals.push({
					id: `p${this.nextId++}`,
					action,
					rationale: mp.rationale ?? "",
					sourceIdeaIds: mp.sourceIdeaIds ?? [],
					status: "pending",
					userEdited: false,
					revision: 0,
					history: [],
				});
				added++;
			}
		}

		// Anything not echoed back was dropped by the model: soft-reject.
		for (const p of this.proposals) {
			if (p.status === "applied" || seenIds.has(p.id)) continue;
			if (p.id.startsWith("p") && p.status !== "rejected" && this.wasSeededBefore(p, modelProposals)) {
				p.status = "rejected";
				p.removedByModel = true;
				removed++;
			}
		}

		this.emit();
		return { added, changed, removed };
	}

	/**
	 * Only treat omission as deletion for proposals that existed before this
	 * revision (i.e. not the ones we just added in this same call).
	 */
	private wasSeededBefore(p: Proposal, modelProposals: ModelProposal[]): boolean {
		// Newly added proposals in this revision have ids the model never saw;
		// the model can't have omitted them intentionally.
		const newCount = modelProposals.filter((mp) => mp.id === "new").length;
		const newestIds = this.proposals.slice(this.proposals.length - newCount).map((x) => x.id);
		return !newestIds.includes(p.id);
	}
}
