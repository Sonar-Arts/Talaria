import { App, Modal } from "obsidian";

/** Simple yes/no dialog; resolves false if dismissed. */
export function confirm(app: App, title: string, message: string, yesText = "Yes", noText = "No"): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new (class extends Modal {
			private done = false;
			onOpen() {
				this.titleEl.setText(title);
				this.contentEl.createDiv({ text: message });
				const buttons = this.contentEl.createDiv({ cls: "idea-triage-picker-buttons" });
				const no = buttons.createEl("button", { text: noText });
				no.addEventListener("click", () => {
					this.done = true;
					resolve(false);
					this.close();
				});
				const yes = buttons.createEl("button", { text: yesText, cls: "mod-cta" });
				yes.addEventListener("click", () => {
					this.done = true;
					resolve(true);
					this.close();
				});
			}
			onClose() {
				if (!this.done) resolve(false);
			}
		})(app);
		modal.open();
	});
}
