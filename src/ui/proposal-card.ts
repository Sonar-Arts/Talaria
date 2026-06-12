import { App, Notice } from "obsidian";
import type { Proposal, ProposalAction } from "../types";
import { ProposalStore } from "../state/proposal-store";
import { resolveNote, revertNoteEdit } from "../vault/note-editor";
import { naiveLineDiff } from "./diff";
import { confirm } from "./confirm-modal";

const KIND_LABEL: Record<ProposalAction["kind"], string> = {
	create_issue: "Create",
	edit_issue: "Edit",
	comment: "Comment",
	set_labels: "Labels",
	edit_note: "Note",
};

const DIFF_MAX_LINES = 200;

/** Render one proposal card into `parent`. Re-rendered wholesale on store change. */
export function renderProposalCard(
	app: App,
	parent: HTMLElement,
	proposal: Proposal,
	store: ProposalStore,
	repo: string
): void {
	const p = proposal;
	const card = parent.createDiv({ cls: `idea-triage-card idea-triage-card-${p.status}` });

	// --- header row ---
	const header = card.createDiv({ cls: "idea-triage-card-header" });

	const cb = header.createEl("input", { type: "checkbox" });
	cb.checked = p.status === "approved";
	cb.disabled = p.status === "applied";
	cb.addEventListener("change", () => {
		store.setStatus(p.id, cb.checked ? "approved" : "pending");
	});

	header.createSpan({ text: p.id, cls: "idea-triage-card-id" });
	header.createSpan({
		text: KIND_LABEL[p.action.kind],
		cls: `idea-triage-badge idea-triage-badge-${p.action.kind}`,
	});

	if (p.action.kind === "edit_note") {
		const path = p.action.path;
		const link = header.createEl("a", {
			text: path.split("/").pop() ?? path,
			href: "#",
		});
		link.addClass("idea-triage-card-issue-link");
		link.title = path;
		link.addEventListener("click", (e) => {
			e.preventDefault();
			app.workspace.openLinkText(path, "", false);
		});
	} else if (p.action.kind !== "create_issue") {
		const link = header.createEl("a", {
			text: `#${p.action.number}`,
			href: `https://github.com/${repo}/issues/${p.action.number}`,
		});
		link.addClass("idea-triage-card-issue-link");
	}

	const title =
		p.action.kind === "create_issue" || p.action.kind === "edit_issue"
			? p.action.title ?? ""
			: "";
	header.createSpan({ text: title, cls: "idea-triage-card-title" });

	// status / revision badges
	const badges = header.createDiv({ cls: "idea-triage-card-badges" });
	if (p.status === "applied") {
		badges.createSpan({
			text: p.createdIssueNumber ? `applied → #${p.createdIssueNumber}` : "applied",
			cls: "idea-triage-badge idea-triage-badge-applied",
		});
		if (p.action.kind === "edit_note" && p.previousNoteContent !== undefined) {
			const action = p.action;
			const previous = p.previousNoteContent;
			const revertNote = badges.createEl("button", { text: "revert note", cls: "idea-triage-mini-btn" });
			revertNote.addEventListener("click", async () => {
				let msg = `Restore the previous content of "${action.path}"? Edits made since apply will be lost.`;
				try {
					const current = await app.vault.read(resolveNote(app, action.path));
					if (current !== action.content) {
						msg = `"${action.path}" has changed since this edit was applied. Restore the pre-apply content anyway? The newer changes will be lost.`;
					}
				} catch {
					// Missing file: revertNoteEdit below reports the real error.
				}
				const ok = await confirm(app, "Revert note", msg, "Revert", "Cancel");
				if (!ok) return;
				try {
					await revertNoteEdit(app, action, previous);
					store.markNoteReverted(p.id);
				} catch (e) {
					new Notice(`Revert failed: ${(e as Error).message}`, 8000);
				}
			});
		}
	}
	if (p.noteReverted) {
		badges.createSpan({
			text: "reverted",
			cls: "idea-triage-badge idea-triage-badge-reverted",
		});
	}
	if (p.status === "failed") {
		const fail = badges.createSpan({
			text: "failed",
			cls: "idea-triage-badge idea-triage-badge-failed",
		});
		if (p.error) fail.title = p.error;
	}
	if (p.removedByModel) {
		badges.createSpan({
			text: "removed by AI",
			cls: "idea-triage-badge idea-triage-badge-removed",
		});
		const restore = badges.createEl("button", { text: "restore", cls: "idea-triage-mini-btn" });
		restore.addEventListener("click", () => store.setStatus(p.id, "pending"));
	} else if (p.revisedByModel) {
		badges.createSpan({
			text: p.userEdited ? "your edit was replaced by AI" : "revised by AI",
			cls: "idea-triage-badge idea-triage-badge-revised",
		});
		if (p.history.length > 0) {
			const revert = badges.createEl("button", { text: "revert", cls: "idea-triage-mini-btn" });
			revert.addEventListener("click", () => store.revert(p.id));
		}
	}

	// --- body ---
	const body = card.createDiv({ cls: "idea-triage-card-body" });
	renderActionDetails(app, body, p);

	if (p.rationale) {
		const why = card.createEl("details", { cls: "idea-triage-card-rationale" });
		why.createEl("summary", { text: "Why" });
		why.createDiv({ text: p.rationale });
	}

	// --- edit ---
	if (p.status !== "applied") {
		const editBtn = card.createEl("button", { text: "✎ Edit", cls: "idea-triage-mini-btn" });
		editBtn.addEventListener("click", () => {
			card.empty();
			renderEditor(card, p, store, repo);
		});
	}
}

function renderActionDetails(app: App, el: HTMLElement, p: Proposal) {
	const a = p.action;
	if (a.kind === "edit_note") {
		el.createDiv({ text: a.path, cls: "idea-triage-card-meta" });
		renderNoteDiff(app, el, a);
		collapsibleText(el, "New content", a.content);
	} else if (a.kind === "create_issue") {
		if (a.labels.length) {
			el.createDiv({ text: `Labels: ${a.labels.join(", ")}`, cls: "idea-triage-card-meta" });
		}
		if (a.body) collapsibleText(el, "Body", a.body);
	} else if (a.kind === "edit_issue") {
		if (a.body !== undefined) collapsibleText(el, "New body", a.body);
		else el.createDiv({ text: "(title change only)", cls: "idea-triage-card-meta" });
	} else if (a.kind === "comment") {
		collapsibleText(el, "Comment", a.body);
	} else {
		const parts: string[] = [];
		if (a.add.length) parts.push(`add: ${a.add.join(", ")}`);
		if (a.remove.length) parts.push(`remove: ${a.remove.join(", ")}`);
		el.createDiv({ text: parts.join(" — ") || "(no label changes)", cls: "idea-triage-card-meta" });
	}
}

/** "Diff" collapsible against the note's current content, filled asynchronously. */
function renderNoteDiff(app: App, el: HTMLElement, a: { path: string; content: string }) {
	const details = el.createEl("details", { cls: "idea-triage-card-text" });
	details.createEl("summary", { text: "Diff" });
	const body = details.createDiv();
	body.setText("…");
	(async () => {
		let current: string;
		try {
			current = await app.vault.cachedRead(resolveNote(app, a.path));
		} catch {
			body.empty();
			body.createDiv({ text: "(file not found)", cls: "idea-triage-diff-missing" });
			return;
		}
		const d = naiveLineDiff(current, a.content);
		body.empty();
		if (d.removed.length === 0 && d.added.length === 0) {
			body.createDiv({ text: "(no changes — file already matches)", cls: "idea-triage-card-meta" });
			return;
		}
		body.createDiv({
			text: `${d.removed.length} line${d.removed.length === 1 ? "" : "s"} removed, ${d.added.length} added (${d.unchangedHead + d.unchangedTail} unchanged)`,
			cls: "idea-triage-card-meta",
		});
		const pre = body.createEl("pre", { cls: "idea-triage-diff" });
		let shown = 0;
		for (const [lines, sign, cls] of [
			[d.removed, "- ", "idea-triage-diff-del"],
			[d.added, "+ ", "idea-triage-diff-add"],
		] as const) {
			for (const line of lines) {
				if (shown >= DIFF_MAX_LINES) break;
				pre.createDiv({ text: sign + line, cls });
				shown++;
			}
		}
		const hidden = d.removed.length + d.added.length - shown;
		if (hidden > 0) pre.createDiv({ text: `… ${hidden} more line${hidden === 1 ? "" : "s"}` });
	})();
}

function collapsibleText(el: HTMLElement, label: string, text: string) {
	const details = el.createEl("details", { cls: "idea-triage-card-text" });
	details.open = text.length < 280;
	details.createEl("summary", { text: label });
	details.createEl("pre", { text });
}

function renderEditor(card: HTMLElement, p: Proposal, store: ProposalStore, repo: string) {
	card.addClass("idea-triage-card-editing");
	const a = p.action;

	let titleInput: HTMLInputElement | null = null;
	let bodyInput: HTMLTextAreaElement | null = null;
	let labelsInput: HTMLInputElement | null = null;
	let addInput: HTMLInputElement | null = null;
	let removeInput: HTMLInputElement | null = null;

	const field = (label: string): HTMLElement => {
		const wrap = card.createDiv({ cls: "idea-triage-edit-field" });
		wrap.createEl("label", { text: label });
		return wrap;
	};

	if (a.kind === "create_issue" || a.kind === "edit_issue") {
		titleInput = field("Title").createEl("input", { type: "text" });
		titleInput.value = a.title ?? "";
	}
	if (a.kind === "edit_note") {
		field("Note").createSpan({ text: a.path, cls: "idea-triage-card-meta" });
		bodyInput = field("Content").createEl("textarea");
		bodyInput.value = a.content;
		bodyInput.rows = 14;
	} else if (a.kind !== "set_labels") {
		bodyInput = field("Body").createEl("textarea");
		bodyInput.value = ("body" in a ? a.body : "") ?? "";
		bodyInput.rows = 8;
	}
	if (a.kind === "create_issue") {
		labelsInput = field("Labels (comma-separated)").createEl("input", { type: "text" });
		labelsInput.value = a.labels.join(", ");
	}
	if (a.kind === "set_labels") {
		addInput = field("Add labels").createEl("input", { type: "text" });
		addInput.value = a.add.join(", ");
		removeInput = field("Remove labels").createEl("input", { type: "text" });
		removeInput.value = a.remove.join(", ");
	}

	const splitCsv = (s: string) =>
		s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);

	const buttons = card.createDiv({ cls: "idea-triage-picker-buttons" });
	const cancel = buttons.createEl("button", { text: "Cancel" });
	cancel.addEventListener("click", () => store.trigger("changed")); // re-render restores view
	const save = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
	save.addEventListener("click", () => {
		let next: typeof p.action;
		switch (a.kind) {
			case "create_issue":
				next = {
					kind: "create_issue",
					title: titleInput!.value.trim(),
					body: bodyInput!.value,
					labels: splitCsv(labelsInput!.value),
				};
				break;
			case "edit_issue":
				next = {
					kind: "edit_issue",
					number: a.number,
					title: titleInput!.value.trim() || undefined,
					body: bodyInput!.value || undefined,
				};
				break;
			case "comment":
				next = { kind: "comment", number: a.number, body: bodyInput!.value };
				break;
			case "set_labels":
				next = {
					kind: "set_labels",
					number: a.number,
					add: splitCsv(addInput!.value),
					remove: splitCsv(removeInput!.value),
				};
				break;
			case "edit_note":
				next = { kind: "edit_note", path: a.path, content: bodyInput!.value };
				break;
		}
		store.userEdit(p.id, next);
	});
}
