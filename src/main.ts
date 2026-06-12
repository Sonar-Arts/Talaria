import { Notice, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { DEFAULT_SETTINGS, IdeaTriageSettings, IdeaTriageSettingTab } from "./settings";
import type { PersistedSession } from "./types";
import { Session } from "./state/session";
import { GhClient } from "./gh/gh-client";
import { extractIdeas, proposeActions } from "./llm/pipeline";
import { NotePickerModal } from "./ui/note-picker-modal";
import { TriageView, TRIAGE_VIEW_TYPE } from "./ui/triage-view";

/** Shape of the plugin data file. */
interface PluginData {
	settings: IdeaTriageSettings;
	session?: PersistedSession;
}

export default class IdeaTriagePlugin extends Plugin {
	settings: IdeaTriageSettings = DEFAULT_SETTINGS;
	/** One session per plugin lifetime; reset on each analysis run. */
	session = new Session();
	/** Debounced so bursts of store changes (e.g. Apply) write once. */
	persistSession = debounce(() => void this.savePluginData(), 1500, true);

	async onload() {
		await this.loadPluginData();

		this.registerView(TRIAGE_VIEW_TYPE, (leaf) => new TriageView(leaf, this));

		// Any proposal change (approve, edit, chat revision, apply) persists the session.
		this.registerEvent(this.session.store.on("changed", () => this.persistSession()));

		this.addRibbonIcon("list-checks", "Analyze notes", () => this.startAnalysis());

		this.addCommand({
			id: "analyze-notes",
			name: "Analyze notes",
			callback: () => this.startAnalysis(),
		});

		this.addCommand({
			id: "open-view",
			name: "Open triage panel",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new IdeaTriageSettingTab(this.app, this));
	}

	async loadPluginData() {
		const raw = (await this.loadData()) as Partial<PluginData> | Record<string, unknown> | null;
		// Legacy layout: settings stored flat at the top level.
		if (raw && !("settings" in raw) && "llmBaseUrl" in raw) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
			return;
		}
		const data = raw as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		if (data?.session) {
			try {
				this.session.restore(data.session);
			} catch (e) {
				console.error("Talaria: could not restore the saved session", e);
			}
		}
	}

	async savePluginData() {
		const data: PluginData = { settings: this.settings };
		const session = this.session.toPersisted();
		if (session) data.session = session;
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	/** Discard the current session (proposals, chat, ideas) and persist the empty state. */
	async clearSession() {
		this.session.reset([]);
		this.session.ideas = [];
		this.session.issues = [];
		this.session.labels = [];
		await this.savePluginData();
	}

	private checkConfigured(): boolean {
		if (!this.settings.llmModel) {
			new Notice("Set the LLM model name in the Talaria settings first.");
			return false;
		}
		if (!/^[\w.-]+\/[\w.-]+$/.test(this.settings.repo)) {
			new Notice("Set the GitHub repository (owner/repo) in the Talaria settings first.");
			return false;
		}
		return true;
	}

	startAnalysis() {
		if (!this.checkConfigured()) return;
		if (this.session.busy) {
			new Notice("An analysis is already running.");
			return;
		}
		new NotePickerModal(this.app, this.settings.maxTotalChars, (files) =>
			this.runPipeline(files)
		).open();
	}

	private async runPipeline(files: TFile[]) {
		const view = await this.activateView();
		const progress = (text: string) => view?.setStatus(text);
		const session = this.session;

		session.busy = true;
		session.reset(files.map((f) => f.path));
		view?.renderProposals();

		try {
			const gh = new GhClient(this.settings);
			progress("Fetching open issues…");
			session.issues = await gh.listIssues();
			progress("Fetching labels…");
			session.labels = await gh.listLabels();

			session.ideas = await extractIdeas(this.app, this.settings, files, progress);
			if (session.ideas.length === 0) {
				progress("");
				new Notice("No actionable ideas found in the selected notes.");
				return;
			}

			const proposals = await proposeActions(
				this.settings,
				session.ideas,
				session.issues,
				session.labels,
				progress
			);
			session.store.seed(proposals);
			progress("");
			new Notice(
				`Found ${session.ideas.length} idea${session.ideas.length === 1 ? "" : "s"}, ` +
					`${proposals.length} proposal${proposals.length === 1 ? "" : "s"}.`
			);
		} catch (e) {
			progress("");
			new Notice(`Analysis failed: ${(e as Error).message}`, 10000);
		} finally {
			session.busy = false;
			view?.renderProposals();
		}
	}

	async activateView(): Promise<TriageView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(TRIAGE_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: TRIAGE_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
		return leaf.view instanceof TriageView ? leaf.view : null;
	}
}
