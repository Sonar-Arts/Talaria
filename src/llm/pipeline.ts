import { App, TFile } from "obsidian";
import type { IdeaTriageSettings } from "../settings";
import type { Idea, IssueRef, ModelProposal } from "../types";
import { withJsonRetry, validateIdeas, validateModelProposals } from "./json-utils";
import { extractIdeasMessages, dedupeIdeasMessages, proposeActionsMessages } from "./prompts";

export interface PipelineProgress {
	(text: string): void;
}

function llmBase(settings: IdeaTriageSettings) {
	return {
		baseUrl: settings.llmBaseUrl,
		apiKey: settings.llmApiKey,
		model: settings.llmModel,
		temperature: 0,
	};
}

/** Read selected notes and split into chunks of at most chunkChars. */
export async function buildChunks(
	app: App,
	files: TFile[],
	chunkChars: number
): Promise<string[]> {
	const chunks: string[] = [];
	let current = "";
	for (const file of files) {
		const content = await app.vault.cachedRead(file);
		const block = `=== NOTE: ${file.path} ===\n${content.trim()}\n\n`;
		if (current && current.length + block.length > chunkChars) {
			chunks.push(current);
			current = "";
		}
		// A single huge note gets split on its own.
		if (block.length > chunkChars) {
			for (let i = 0; i < block.length; i += chunkChars) {
				const piece = block.slice(i, i + chunkChars);
				if (current) {
					chunks.push(current);
					current = "";
				}
				chunks.push(
					i === 0 ? piece : `=== NOTE: ${file.path} (continued) ===\n${piece}`
				);
			}
		} else {
			current += block;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Phase A: extract & categorize ideas from the selected notes. */
export async function extractIdeas(
	app: App,
	settings: IdeaTriageSettings,
	files: TFile[],
	progress: PipelineProgress
): Promise<Idea[]> {
	const chunks = await buildChunks(app, files, settings.chunkChars);
	if (chunks.length === 0) throw new Error("The selected notes are empty.");

	const collected: Omit<Idea, "id">[] = [];
	for (let i = 0; i < chunks.length; i++) {
		progress(
			chunks.length > 1
				? `Extracting ideas… chunk ${i + 1}/${chunks.length}`
				: "Extracting ideas…"
		);
		const ideas = await withJsonRetry(
			{ ...llmBase(settings), messages: extractIdeasMessages(chunks[i]) },
			validateIdeas
		);
		collected.push(...ideas);
	}

	let withIds: Idea[] = collected.map((idea, i) => ({ ...idea, id: `i${i + 1}` }));

	if (chunks.length > 1 && settings.dedupeIdeas && withIds.length > 1) {
		progress("Merging duplicate ideas…");
		try {
			const merged = await withJsonRetry(
				{ ...llmBase(settings), messages: dedupeIdeasMessages(withIds) },
				validateIdeas,
				1
			);
			if (merged.length > 0) {
				withIds = merged.map((idea, i) => ({ ...idea, id: `i${i + 1}` }));
			}
		} catch {
			// Dedupe is best-effort; keep the raw list on failure.
		}
	}
	return withIds;
}

/** Phase B: compare ideas with open issues and propose actions. */
export async function proposeActions(
	settings: IdeaTriageSettings,
	ideas: Idea[],
	issues: IssueRef[],
	labels: string[],
	progress: PipelineProgress
): Promise<ModelProposal[]> {
	progress("Comparing ideas with open issues…");
	return await withJsonRetry(
		{
			...llmBase(settings),
			messages: proposeActionsMessages(ideas, issues, labels, settings.repo),
		},
		validateModelProposals
	);
}
