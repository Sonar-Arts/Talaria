import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type IdeaTriagePlugin from "../main";
import type { ChatMessage } from "../types";
import { chatCompletion } from "../llm/transport";
import { splitProposalsBlock, splitReadBlock, extractJson, validateModelProposals } from "../llm/json-utils";
import { chatSystemPrompt } from "../llm/prompts";
import { GhClient } from "../gh/gh-client";
import {
	MAX_READ_ROUNDS,
	applyNoteEdit,
	listVaultNotePaths,
	readNotesForModel,
} from "../vault/note-editor";
import { renderProposalCard } from "./proposal-card";
import { confirm } from "./confirm-modal";

export const TRIAGE_VIEW_TYPE = "idea-triage";

export class TriageView extends ItemView {
	private proposalsEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private applyBtn!: HTMLButtonElement;
	private chatLogEl!: HTMLElement;
	private chatInput!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private abortController: AbortController | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: IdeaTriagePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return TRIAGE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Talaria";
	}

	getIcon(): string {
		return "list-checks";
	}

	private get session() {
		return this.plugin.session;
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("idea-triage-view");

		// --- toolbar ---
		const toolbar = root.createDiv({ cls: "idea-triage-toolbar" });
		toolbar.createSpan({ text: this.plugin.settings.repo || "(no repo set)", cls: "idea-triage-repo" });

		const refreshBtn = toolbar.createEl("button", { text: "Refresh issues", cls: "idea-triage-mini-btn" });
		refreshBtn.addEventListener("click", () => this.refreshIssues());

		const clearBtn = toolbar.createEl("button", { text: "Clear", cls: "idea-triage-mini-btn" });
		clearBtn.addEventListener("click", () => this.clearSession());

		const approveAllBtn = toolbar.createEl("button", { text: "Approve all", cls: "idea-triage-mini-btn" });
		approveAllBtn.addEventListener("click", () => this.session.store.setAllApproved());

		this.applyBtn = toolbar.createEl("button", { text: "Apply (0)", cls: "mod-cta idea-triage-apply-btn" });
		this.applyBtn.addEventListener("click", () => this.applyApproved());

		this.statusEl = root.createDiv({ cls: "idea-triage-status" });

		// --- proposals ---
		this.proposalsEl = root.createDiv({ cls: "idea-triage-proposals" });

		// --- chat ---
		const chatWrap = root.createDiv({ cls: "idea-triage-chat" });
		this.chatLogEl = chatWrap.createDiv({ cls: "idea-triage-chat-log" });
		const inputRow = chatWrap.createDiv({ cls: "idea-triage-chat-input-row" });
		this.chatInput = inputRow.createEl("textarea", {
			placeholder: "Discuss the proposals… (Enter to send, Shift+Enter for newline)",
		});
		this.chatInput.rows = 2;
		this.chatInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendChat();
			}
		});
		this.sendBtn = inputRow.createEl("button", { cls: "idea-triage-send-btn" });
		setIcon(this.sendBtn, "send");
		this.sendBtn.addEventListener("click", () => {
			if (this.abortController) {
				this.abortController.abort();
			} else {
				this.sendChat();
			}
		});

		this.registerEvent(this.session.store.on("changed", () => this.renderProposals()));

		this.renderProposals();
		this.renderChatLog();
	}

	setStatus(text: string) {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("idea-triage-status-active", !!text);
	}

	renderProposals() {
		this.proposalsEl.empty();
		const proposals = this.session.store.all();
		if (proposals.length === 0) {
			this.proposalsEl.createDiv({
				text:
					this.session.ideas.length > 0
						? "No proposals — the model found nothing to change."
						: 'No session yet. Run "Analyze notes" to start.',
				cls: "idea-triage-empty",
			});
		}
		for (const p of proposals) {
			renderProposalCard(this.app, this.proposalsEl, p, this.session.store, this.plugin.settings.repo);
		}
		const n = this.session.store.approvedCount();
		this.applyBtn.setText(`Apply (${n})`);
		this.applyBtn.disabled = n === 0 || this.session.busy;
	}

	// ---------- chat ----------

	private renderChatLog() {
		this.chatLogEl.empty();
		for (const msg of this.session.chat) {
			this.appendBubble(msg.role === "user" ? "user" : "assistant", msg.content);
		}
		this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
	}

	private appendBubble(kind: "user" | "assistant" | "pill" | "warn", text: string): HTMLElement {
		const el = this.chatLogEl.createDiv({ cls: `idea-triage-bubble idea-triage-bubble-${kind}` });
		el.setText(text);
		this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
		return el;
	}

	private async sendChat() {
		const text = this.chatInput.value.trim();
		if (!text || this.session.busy) return;
		if (this.session.ideas.length === 0 && this.session.store.all().length === 0) {
			new Notice("Run an analysis first so there is something to discuss.");
			return;
		}
		this.chatInput.value = "";
		this.session.chat.push({ role: "user", content: text });
		this.appendBubble("user", text);
		await this.runAssistantTurn();
	}

	private async clearSession() {
		if (this.session.busy) {
			new Notice("Wait for the current operation to finish first.");
			return;
		}
		if (this.session.store.all().length === 0 && this.session.chat.length === 0) return;
		const ok = await confirm(
			this.app,
			"Clear session",
			"Discard all proposals, extracted ideas, and the chat history? Already-applied changes stay on GitHub.",
			"Clear",
			"Cancel"
		);
		if (!ok) return;
		await this.plugin.clearSession();
		this.renderProposals();
		this.renderChatLog();
		this.setStatus("");
	}

	/** One assistant turn; on invalid proposals block, retries once silently. */
	private async runAssistantTurn(retry = false): Promise<void> {
		const s = this.plugin.settings;
		const session = this.session;
		session.busy = true;
		this.abortController = new AbortController();
		setIcon(this.sendBtn, "square");
		this.sendBtn.title = "Stop";

		let bubble = this.appendBubble("assistant", "…");
		let streamed = "";

		try {
			const messages: ChatMessage[] = [
				{
					role: "system",
					content: chatSystemPrompt(
						session.ideas,
						session.issues,
						session.labels,
						[...session.store.all()],
						s.repo,
						listVaultNotePaths(this.app)
					),
				},
				...session.recentChat(s.maxChatTurns),
			];

			// The model may ask to read vault notes before answering; serve at
			// most MAX_READ_ROUNDS such requests. The read exchange stays in the
			// local messages array only — session.chat gets just the final reply.
			const maxCompletions = MAX_READ_ROUNDS + 2;
			let full = "";
			for (let attempt = 1; ; attempt++) {
				streamed = "";
				full = await chatCompletion({
					baseUrl: s.llmBaseUrl,
					apiKey: s.llmApiKey,
					model: s.llmModel,
					messages,
					temperature: s.chatTemperature,
					stream: true,
					signal: this.abortController.signal,
					onToken: (t) => {
						streamed += t;
						// Hide proposals/read blocks while they stream in.
						bubble.setText(splitReadBlock(splitProposalsBlock(streamed).prose).prose || "…");
						this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
					},
				});

				const read = splitReadBlock(full);
				if (!read.paths || attempt >= maxCompletions) {
					// Budget exhausted with a dangling read block: keep the prose only.
					if (read.paths) full = read.prose;
					break;
				}
				messages.push({ role: "assistant", content: full });
				if (attempt > MAX_READ_ROUNDS) {
					bubble.setText(read.prose || "…");
					messages.push({
						role: "user",
						content:
							"(plugin) No note reads remain this turn — answer now with what you already have; do not emit another read block.",
					});
				} else {
					bubble.setText(read.prose || "(reading notes…)");
					this.appendBubble("pill", `Reading: ${read.paths.join(", ")}`);
					messages.push({ role: "user", content: await readNotesForModel(this.app, read.paths) });
				}
				bubble = this.appendBubble("assistant", "…");
			}

			const { prose, block } = splitProposalsBlock(full);
			bubble.setText(prose || "(updated proposals)");
			session.chat.push({ role: "assistant", content: full });

			if (block) {
				try {
					const revised = validateModelProposals(extractJson(block));
					const { added, changed, removed } = session.store.applyModelRevision(revised);
					const parts: string[] = [];
					if (added) parts.push(`${added} added`);
					if (changed) parts.push(`${changed} changed`);
					if (removed) parts.push(`${removed} removed`);
					this.appendBubble("pill", parts.length ? `Proposals updated: ${parts.join(", ")}` : "Proposals unchanged");
				} catch (e) {
					if (!retry) {
						this.appendBubble("warn", "The model's proposal update was malformed — asking it to fix it…");
						session.chat.push({
							role: "user",
							content: `Your proposals block was invalid: ${(e as Error).message} Send a corrected \`\`\`proposals block containing the complete list.`,
						});
						session.busy = false;
						this.resetSendButton();
						await this.runAssistantTurn(true);
						return;
					}
					this.appendBubble("warn", "Could not parse the model's proposal update; the list is unchanged.");
				}
			}
		} catch (e) {
			if ((e as Error).name === "AbortError") {
				bubble.setText((splitReadBlock(splitProposalsBlock(streamed).prose).prose || "") + " ⏹ (stopped)");
				if (streamed) session.chat.push({ role: "assistant", content: streamed });
			} else {
				bubble.setText(`Error: ${(e as Error).message}`);
			}
		} finally {
			session.busy = false;
			this.resetSendButton();
			this.renderProposals();
			// Chat turns don't go through the proposal store, so persist explicitly.
			this.plugin.persistSession();
		}
	}

	private resetSendButton() {
		this.abortController = null;
		setIcon(this.sendBtn, "send");
		this.sendBtn.title = "Send";
	}

	// ---------- gh actions ----------

	private async refreshIssues() {
		const gh = new GhClient(this.plugin.settings);
		this.setStatus("Fetching issues…");
		try {
			this.session.issues = await gh.listIssues();
			this.session.labels = await gh.listLabels();
			this.setStatus("");
			new Notice(`Fetched ${this.session.issues.length} open issues.`);
		} catch (e) {
			this.setStatus("");
			new Notice((e as Error).message, 8000);
		}
	}

	private async applyApproved() {
		const session = this.session;
		if (session.busy) return;
		const approved = session.store.all().filter((p) => p.status === "approved");
		if (approved.length === 0) return;

		const gh = new GhClient(this.plugin.settings);
		session.busy = true;
		this.applyBtn.disabled = true;

		try {
			// Pre-check labels used by create_issue proposals.
			const known = new Set(session.labels);
			const wanted = new Set<string>();
			for (const p of approved) {
				if (p.action.kind === "create_issue") p.action.labels.forEach((l) => wanted.add(l));
				if (p.action.kind === "set_labels") p.action.add.forEach((l) => wanted.add(l));
			}
			const missing = [...wanted].filter((l) => !known.has(l));
			if (missing.length > 0 && session.labels.length > 0) {
				const create = await confirm(
					this.app,
					"Labels do not exist",
					`These labels don't exist in ${this.plugin.settings.repo}: ${missing.join(", ")}. Create them? (No = drop them from the proposals)`,
					"Create labels",
					"Drop labels"
				);
				if (create) {
					for (const label of missing) {
						this.setStatus(`Creating label "${label}"…`);
						await gh.createLabel(label);
						session.labels.push(label);
					}
				} else {
					for (const p of approved) {
						if (p.action.kind === "create_issue") {
							p.action.labels = p.action.labels.filter((l) => !missing.includes(l));
						} else if (p.action.kind === "set_labels") {
							p.action.add = p.action.add.filter((l) => !missing.includes(l));
						}
					}
				}
			}

			let ok = 0;
			let failed = 0;
			for (let i = 0; i < approved.length; i++) {
				const p = approved[i];
				this.setStatus(`Applying ${i + 1}/${approved.length} (${p.id})…`);
				try {
					if (p.action.kind === "edit_note") {
						const prev = await applyNoteEdit(this.app, p.action);
						session.store.markApplied(p.id, undefined, prev);
					} else {
						const createdNumber = await gh.apply(p.action);
						session.store.markApplied(p.id, createdNumber);
					}
					ok++;
				} catch (e) {
					session.store.markFailed(p.id, (e as Error).message);
					failed++;
				}
			}
			this.setStatus("");
			const allNotes = approved.every((p) => p.action.kind === "edit_note");
			new Notice(
				failed === 0
					? `Applied ${ok} change${ok === 1 ? "" : "s"}${allNotes ? "" : ` to ${this.plugin.settings.repo}`}.`
					: `Applied ${ok}, ${failed} failed — hover the "failed" badge for details.`,
				8000
			);
		} finally {
			session.busy = false;
			this.renderProposals();
		}
	}

	async onClose() {
		this.abortController?.abort();
	}
}
