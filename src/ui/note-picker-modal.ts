import { App, Modal, TFile, TFolder } from "obsidian";

interface Row {
	kind: "folder" | "note";
	path: string;
	/** For folders: all markdown files underneath (recursive). */
	files: TFile[];
}

/**
 * Searchable checkbox multi-select over the vault's notes and folders.
 * Checking a folder selects every markdown file under it.
 */
export class NotePickerModal extends Modal {
	private rows: Row[] = [];
	private selected = new Set<string>(); // note paths
	private listEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private query = "";

	constructor(
		app: App,
		private maxTotalChars: number,
		private onConfirm: (files: TFile[]) => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Select notes to analyze");
		this.modalEl.addClass("idea-triage-picker");

		const files = this.app.vault.getMarkdownFiles();
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/");

		const byFolder = (folder: TFolder): TFile[] =>
			files.filter((f) => f.path === folder.path + "/" + f.name || f.path.startsWith(folder.path + "/"));

		this.rows = [
			...folders
				.map((f) => ({ kind: "folder" as const, path: f.path, files: byFolder(f) }))
				.filter((r) => r.files.length > 0),
			...files.map((f) => ({ kind: "note" as const, path: f.path, files: [f] })),
		].sort((a, b) => a.path.localeCompare(b.path));

		const search = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Filter notes and folders…",
			cls: "idea-triage-picker-search",
		});
		search.addEventListener("input", () => {
			this.query = search.value.toLowerCase();
			this.renderList();
		});

		this.listEl = this.contentEl.createDiv({ cls: "idea-triage-picker-list" });
		this.footerEl = this.contentEl.createDiv({ cls: "idea-triage-picker-footer" });

		const buttons = this.contentEl.createDiv({ cls: "idea-triage-picker-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const confirm = buttons.createEl("button", { text: "Analyze", cls: "mod-cta" });
		confirm.addEventListener("click", () => {
			const chosen = this.selectedFiles();
			if (chosen.length === 0) return;
			this.close();
			this.onConfirm(chosen);
		});

		this.renderList();
		this.updateFooter();
		search.focus();
	}

	private selectedFiles(): TFile[] {
		const all = this.app.vault.getMarkdownFiles();
		return all.filter((f) => this.selected.has(f.path));
	}

	private renderList() {
		this.listEl.empty();
		const visible = this.query
			? this.rows.filter((r) => r.path.toLowerCase().includes(this.query))
			: this.rows;

		for (const row of visible.slice(0, 500)) {
			const item = this.listEl.createDiv({ cls: "idea-triage-picker-row" });
			const cb = item.createEl("input", { type: "checkbox" });
			cb.checked =
				row.kind === "note"
					? this.selected.has(row.path)
					: row.files.every((f) => this.selected.has(f.path));
			item.createSpan({
				text: (row.kind === "folder" ? "📁 " : "") + row.path,
				cls: row.kind === "folder" ? "idea-triage-picker-folder" : "",
			});
			const toggle = () => {
				const check = !(row.kind === "note"
					? this.selected.has(row.path)
					: row.files.every((f) => this.selected.has(f.path)));
				for (const f of row.files) {
					if (check) this.selected.add(f.path);
					else this.selected.delete(f.path);
				}
				this.renderList();
				this.updateFooter();
			};
			cb.addEventListener("click", (e) => {
				e.preventDefault();
				toggle();
			});
			item.addEventListener("click", (e) => {
				if (e.target !== cb) toggle();
			});
		}
		if (visible.length > 500) {
			this.listEl.createDiv({
				text: `…${visible.length - 500} more — refine the filter`,
				cls: "idea-triage-picker-more",
			});
		}
	}

	private async updateFooter() {
		const files = this.selectedFiles();
		let bytes = 0;
		for (const f of files) bytes += f.stat.size;
		const kb = Math.round(bytes / 1024);
		this.footerEl.setText(`${files.length} note${files.length === 1 ? "" : "s"}, ~${kb} KB selected`);
		this.footerEl.toggleClass("idea-triage-picker-warn", bytes > this.maxTotalChars);
		if (bytes > this.maxTotalChars) {
			this.footerEl.setText(
				`${files.length} notes, ~${kb} KB selected — large selection, extraction will run in multiple chunks`
			);
		}
	}
}
