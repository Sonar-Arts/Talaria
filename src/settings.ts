import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type IdeaTriagePlugin from "./main";
import { chatCompletion } from "./llm/transport";
import { GhClient } from "./gh/gh-client";
import { RepoPickerModal } from "./ui/repo-picker-modal";

export interface IdeaTriageSettings {
	/** OpenAI-compatible base URL including /v1, e.g. http://localhost:11434/v1 */
	llmBaseUrl: string;
	llmModel: string;
	llmApiKey: string;
	/** Temperature for the chat panel; pipeline calls always use 0. */
	chatTemperature: number;
	/** owner/repo */
	repo: string;
	/** Path to the gh executable; "gh" resolves via PATH. */
	ghPath: string;
	/** Max open issues fetched and included in prompts. */
	maxIssues: number;
	/** Max characters of note content per extraction call. */
	chunkChars: number;
	/** Soft warning threshold for total selected note size. */
	maxTotalChars: number;
	/** Chat turns kept in history (state lives in the system prompt). */
	maxChatTurns: number;
	/** Run a dedupe pass when ideas come from multiple chunks. */
	dedupeIdeas: boolean;
}

export const DEFAULT_SETTINGS: IdeaTriageSettings = {
	llmBaseUrl: "http://localhost:11434/v1",
	llmModel: "",
	llmApiKey: "",
	chatTemperature: 0.4,
	repo: "",
	ghPath: "gh",
	maxIssues: 100,
	chunkChars: 12000,
	maxTotalChars: 60000,
	maxChatTurns: 20,
	dedupeIdeas: true,
};

export class IdeaTriageSettingTab extends PluginSettingTab {
	plugin: IdeaTriagePlugin;

	constructor(app: App, plugin: IdeaTriagePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Local LLM").setHeading();

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc(
				"OpenAI-compatible endpoint, including /v1. Ollama: http://localhost:11434/v1 — LM Studio: http://localhost:1234/v1"
			)
			.addText((t) =>
				t
					.setPlaceholder("http://localhost:11434/v1")
					.setValue(this.plugin.settings.llmBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.llmBaseUrl = v.trim().replace(/\/+$/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model name as your server knows it, e.g. qwen2.5:7b-instruct")
			.addText((t) =>
				t
					.setPlaceholder("qwen2.5:7b-instruct")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (v) => {
						this.plugin.settings.llmModel = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Optional. Most local servers ignore it.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.llmApiKey).onChange(async (v) => {
					this.plugin.settings.llmApiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Chat temperature")
			.setDesc("Used only for the chat panel. Idea extraction always runs at 0.")
			.addSlider((s) =>
				s
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.chatTemperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.chatTemperature = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test LLM connection")
			.setDesc("Sends a tiny request to the configured endpoint.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true);
					try {
						const reply = await chatCompletion({
							baseUrl: this.plugin.settings.llmBaseUrl,
							apiKey: this.plugin.settings.llmApiKey,
							model: this.plugin.settings.llmModel,
							messages: [{ role: "user", content: "Reply with the single word: ok" }],
							temperature: 0,
							stream: false,
							maxTokens: 10,
						});
						new Notice(`LLM responded: "${reply.trim().slice(0, 80)}"`);
					} catch (e) {
						new Notice(`LLM connection failed: ${(e as Error).message}`, 8000);
					} finally {
						b.setDisabled(false);
					}
				})
			);

		new Setting(containerEl).setName("GitHub").setHeading();

		new Setting(containerEl)
			.setName("Repository")
			.setDesc("owner/repo to triage issues against. Use Pick to choose from your repos.")
			.addText((t) =>
				t
					.setPlaceholder("owner/repo")
					.setValue(this.plugin.settings.repo)
					.onChange(async (v) => {
						this.plugin.settings.repo = v.trim();
						await this.plugin.saveSettings();
					})
			)
			.addButton((b) =>
				b.setButtonText("Pick").onClick(async () => {
					const gh = new GhClient(this.plugin.settings);
					try {
						const repos = await gh.listRepos();
						new RepoPickerModal(this.app, repos, async (repo) => {
							this.plugin.settings.repo = repo;
							await this.plugin.saveSettings();
							this.display();
						}).open();
					} catch (e) {
						new Notice(`Could not list repos: ${(e as Error).message}`, 8000);
					}
				})
			);

		new Setting(containerEl)
			.setName("gh executable")
			.setDesc('Path to the GitHub CLI. Leave as "gh" if it is on your PATH.')
			.addText((t) =>
				t
					.setPlaceholder("gh")
					.setValue(this.plugin.settings.ghPath)
					.onChange(async (v) => {
						this.plugin.settings.ghPath = v.trim() || "gh";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test gh")
			.setDesc("Checks that the GitHub CLI is installed and authenticated.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true);
					const gh = new GhClient(this.plugin.settings);
					try {
						const version = await gh.version();
						const auth = await gh.authStatus();
						new Notice(`${version}\n${auth}`, 8000);
					} catch (e) {
						new Notice(`gh check failed: ${(e as Error).message}`, 10000);
					} finally {
						b.setDisabled(false);
					}
				})
			);

		new Setting(containerEl).setName("Limits").setHeading();

		new Setting(containerEl)
			.setName("Max issues")
			.setDesc("How many open issues to fetch and show the model (default 100).")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxIssues)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.maxIssues = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Chunk size (characters)")
			.setDesc(
				"Note content per extraction call. Lower this for small-context models (12000 ≈ 3-4k tokens)."
			)
			.addText((t) =>
				t.setValue(String(this.plugin.settings.chunkChars)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 1000) {
						this.plugin.settings.chunkChars = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Dedupe ideas")
			.setDesc("Run an extra merge pass when ideas come from multiple chunks.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.dedupeIdeas).onChange(async (v) => {
					this.plugin.settings.dedupeIdeas = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
