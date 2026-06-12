import type { ChatMessage, Idea, IssueRef, PersistedSession } from "../types";
import { ProposalStore } from "./proposal-store";

/** One triage run: selected notes → ideas → issues snapshot → proposals → chat. */
export class Session {
	notePaths: string[] = [];
	ideas: Idea[] = [];
	issues: IssueRef[] = [];
	labels: string[] = [];
	chat: ChatMessage[] = []; // user/assistant turns only; system prompt rebuilt each turn
	store = new ProposalStore();
	/** True while the pipeline or an apply/chat call is running. */
	busy = false;

	reset(notePaths: string[]) {
		this.notePaths = notePaths;
		this.ideas = [];
		this.chat = [];
		this.store.clear();
	}

	/** History sent to the model, truncated to the most recent turns. */
	recentChat(maxTurns: number): ChatMessage[] {
		return this.chat.slice(-maxTurns);
	}

	/** Snapshot for the plugin data file; null when there is nothing worth saving. */
	toPersisted(): PersistedSession | null {
		const { proposals, nextId } = this.store.serialize();
		if (this.ideas.length === 0 && proposals.length === 0 && this.chat.length === 0) {
			return null;
		}
		return {
			notePaths: this.notePaths,
			ideas: this.ideas,
			issues: this.issues,
			labels: this.labels,
			chat: this.chat,
			proposals,
			nextId,
		};
	}

	restore(p: PersistedSession) {
		this.notePaths = p.notePaths ?? [];
		this.ideas = p.ideas ?? [];
		this.issues = p.issues ?? [];
		this.labels = p.labels ?? [];
		this.chat = p.chat ?? [];
		this.busy = false;
		this.store.restore(p.proposals ?? [], p.nextId ?? 1);
	}
}
