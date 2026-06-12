import { App, FuzzySuggestModal } from "obsidian";

export class RepoPickerModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private repos: string[],
		private onPick: (repo: string) => void
	) {
		super(app);
		this.setPlaceholder("Pick a repository…");
	}

	getItems(): string[] {
		return this.repos;
	}

	getItemText(repo: string): string {
		return repo;
	}

	onChooseItem(repo: string): void {
		this.onPick(repo);
	}
}
