import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type { IdeaTriageSettings } from "../settings";
import type { IssueRef, ProposalAction } from "../types";

export class GhError extends Error {
	constructor(message: string, public exitCode: number | null, public stderr: string) {
		super(message);
		this.name = "GhError";
	}
}

interface RunOptions {
	/** Treat a non-zero exit as success and return stderr (gh auth status quirk). */
	allowNonZero?: boolean;
}

export class GhClient {
	constructor(private settings: IdeaTriageSettings) {}

	private get repo(): string {
		const repo = this.settings.repo.trim();
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
			throw new GhError(
				`Repository "${repo || "(empty)"}" is not set or not in owner/repo form. Configure it in the plugin settings.`,
				null,
				""
			);
		}
		return repo;
	}

	private run(args: string[], opts: RunOptions = {}): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.settings.ghPath || "gh", args, {
				shell: false,
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
			child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
			child.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") {
					reject(
						new GhError(
							`GitHub CLI not found ("${this.settings.ghPath}"). Install it from https://cli.github.com or set its full path in the plugin settings.`,
							null,
							""
						)
					);
				} else {
					reject(new GhError(`Failed to run gh: ${err.message}`, null, ""));
				}
			});
			child.on("close", (code) => {
				if (code === 0 || opts.allowNonZero) {
					resolve(stdout || stderr);
				} else {
					const detail = (stderr || stdout).trim();
					let msg = `gh ${args[0]} ${args[1] ?? ""} failed (exit ${code})`;
					if (/not logged in|authentication|auth login/i.test(detail)) {
						msg = "GitHub CLI is not logged in. Run `gh auth login` in a terminal.";
					} else if (detail) {
						msg += `: ${detail.slice(0, 400)}`;
					}
					reject(new GhError(msg, code, detail));
				}
			});
		});
	}

	/** Run a command whose body is passed via a temp file (--body-file). */
	private async runWithBody(args: string[], body: string): Promise<string> {
		const file = path.join(os.tmpdir(), `idea-triage-${randomUUID()}.md`);
		await fs.writeFile(file, body, "utf8");
		try {
			return await this.run([...args, "--body-file", file]);
		} finally {
			await fs.unlink(file).catch(() => {});
		}
	}

	async version(): Promise<string> {
		const out = await this.run(["--version"]);
		return out.split("\n")[0].trim();
	}

	async authStatus(): Promise<string> {
		// gh auth status writes to stderr and exits non-zero when logged out.
		const out = await this.run(["auth", "status"], { allowNonZero: true });
		if (/not logged in|no .*hosts configured/i.test(out)) {
			throw new GhError(
				"GitHub CLI is not logged in. Run `gh auth login` in a terminal.",
				null,
				out
			);
		}
		const line = out.split("\n").find((l) => /logged in/i.test(l));
		return line ? line.trim().replace(/^[✓√x]\s*/i, "") : "Authenticated.";
	}

	async listIssues(): Promise<IssueRef[]> {
		const out = await this.run([
			"issue",
			"list",
			"-R",
			this.repo,
			"--state",
			"open",
			"--json",
			"number,title,body,labels",
			"--limit",
			String(this.settings.maxIssues),
		]);
		const raw = JSON.parse(out) as Array<{
			number: number;
			title: string;
			body: string | null;
			labels: Array<{ name: string }>;
		}>;
		return raw.map((i) => ({
			number: i.number,
			title: i.title,
			body: i.body ?? "",
			labels: (i.labels ?? []).map((l) => l.name),
		}));
	}

	async listLabels(): Promise<string[]> {
		const out = await this.run([
			"label",
			"list",
			"-R",
			this.repo,
			"--json",
			"name",
			"--limit",
			"200",
		]);
		const raw = JSON.parse(out) as Array<{ name: string }>;
		return raw.map((l) => l.name);
	}

	async listRepos(): Promise<string[]> {
		const out = await this.run([
			"repo",
			"list",
			"--json",
			"nameWithOwner",
			"--limit",
			"100",
		]);
		const raw = JSON.parse(out) as Array<{ nameWithOwner: string }>;
		return raw.map((r) => r.nameWithOwner);
	}

	async createLabel(name: string): Promise<void> {
		await this.run(["label", "create", name, "-R", this.repo]);
	}

	/** Returns the new issue number parsed from the URL gh prints. */
	async createIssue(title: string, body: string, labels: string[]): Promise<number> {
		const args = ["issue", "create", "-R", this.repo, "--title", title];
		for (const label of labels) {
			args.push("--label", label);
		}
		const out = await this.runWithBody(args, body);
		const match = out.trim().match(/\/issues\/(\d+)\s*$/m);
		return match ? parseInt(match[1], 10) : NaN;
	}

	async editIssue(number: number, title?: string, body?: string): Promise<void> {
		const args = ["issue", "edit", String(number), "-R", this.repo];
		if (title !== undefined) {
			args.push("--title", title);
		}
		if (body !== undefined) {
			await this.runWithBody(args, body);
		} else {
			await this.run(args);
		}
	}

	async comment(number: number, body: string): Promise<void> {
		await this.runWithBody(["issue", "comment", String(number), "-R", this.repo], body);
	}

	async setLabels(number: number, add: string[], remove: string[]): Promise<void> {
		const args = ["issue", "edit", String(number), "-R", this.repo];
		if (add.length) args.push("--add-label", add.join(","));
		if (remove.length) args.push("--remove-label", remove.join(","));
		if (args.length === 5) return; // nothing to do
		await this.run(args);
	}

	/** Execute one proposal action. Returns created issue number for create_issue. */
	async apply(action: Exclude<ProposalAction, { kind: "edit_note" }>): Promise<number | undefined> {
		switch (action.kind) {
			case "create_issue":
				return await this.createIssue(action.title, action.body, action.labels);
			case "edit_issue":
				await this.editIssue(action.number, action.title, action.body);
				return;
			case "comment":
				await this.comment(action.number, action.body);
				return;
			case "set_labels":
				await this.setLabels(action.number, action.add, action.remove);
				return;
		}
	}
}
