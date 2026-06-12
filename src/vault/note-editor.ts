import { App, TFile, normalizePath } from "obsidian";

/** Max ```read rounds per assistant turn before the model must answer. */
export const MAX_READ_ROUNDS = 2;
/** Max paths honored per read round. */
export const MAX_READ_FILES = 5;
/** Per-file cap when feeding note content to the model. */
export const MAX_READ_CHARS_PER_FILE = 8000;
/** Total cap per read round. */
export const MAX_READ_CHARS_TOTAL = 24000;
/** Above this size the previous content is not kept for undo. */
export const MAX_UNDO_CHARS = 100000;

/** Resolve a vault path to an existing markdown file or throw. */
export function resolveNote(app: App, rawPath: string): TFile {
	const path = normalizePath(rawPath.trim());
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		throw new Error(`Note not found: "${path}" — edit_note never creates files.`);
	}
	if (file.extension !== "md") {
		throw new Error(`"${path}" is not a markdown note.`);
	}
	return file;
}

/**
 * Overwrite a note with the proposed content. Returns the content the file
 * had immediately before the write, for in-session undo.
 */
export async function applyNoteEdit(
	app: App,
	action: { path: string; content: string }
): Promise<string> {
	const file = resolveNote(app, action.path);
	const prev = await app.vault.read(file);
	await app.vault.modify(file, action.content);
	return prev;
}

export async function revertNoteEdit(
	app: App,
	action: { path: string },
	previousContent: string
): Promise<void> {
	const file = resolveNote(app, action.path);
	await app.vault.modify(file, previousContent);
}

export function listVaultNotePaths(app: App): string[] {
	return app.vault.getMarkdownFiles().map((f) => f.path);
}

/**
 * Read the requested notes for the model, framed like buildChunks()'s
 * "=== NOTE: path ===" blocks. Missing files and size caps are reported
 * inline so the model can self-correct or decline to edit.
 */
export async function readNotesForModel(app: App, paths: string[]): Promise<string> {
	const blocks: string[] = [];
	const dropped = paths.length > MAX_READ_FILES ? paths.length - MAX_READ_FILES : 0;
	let total = 0;
	for (const rawPath of paths.slice(0, MAX_READ_FILES)) {
		const path = normalizePath(rawPath.trim());
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== "md") {
			blocks.push(`=== NOTE: ${path} ===\n(NOT FOUND — check the path against the vault list)`);
			continue;
		}
		if (total >= MAX_READ_CHARS_TOTAL) {
			blocks.push(`=== NOTE: ${path} ===\n(SKIPPED — read budget for this round is used up)`);
			continue;
		}
		const content = await app.vault.cachedRead(file);
		const cap = Math.min(MAX_READ_CHARS_PER_FILE, MAX_READ_CHARS_TOTAL - total);
		const truncated = content.length > cap;
		const shown = truncated ? content.slice(0, cap) : content;
		total += shown.length;
		blocks.push(
			`=== NOTE: ${path} ===\n${shown}` +
				(truncated
					? `\n…[truncated: note is ${content.length} chars — too large to edit safely; tell the user instead of proposing an edit]`
					: "")
		);
	}
	if (dropped > 0) {
		blocks.push(`(${dropped} more path${dropped === 1 ? "" : "s"} ignored — at most ${MAX_READ_FILES} notes per read)`);
	}
	return blocks.join("\n\n");
}
