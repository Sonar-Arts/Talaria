// Copies the built plugin into an Obsidian vault.
// Usage: node scripts/install-vault.mjs [vault-path]
// A copy (not a junction) keeps OneDrive from syncing node_modules.
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
	console.error(
		'Usage: node scripts/install-vault.mjs <vault-path>   (or set OBSIDIAN_VAULT)'
	);
	process.exit(1);
}
if (!existsSync(join(vault, ".obsidian"))) {
	console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
	process.exit(1);
}

const files = ["main.js", "manifest.json", "styles.css"];
for (const f of files) {
	if (!existsSync(f)) {
		console.error(`Missing ${f} — run "npm run build" first.`);
		process.exit(1);
	}
}

const dest = join(vault, ".obsidian", "plugins", "idea-triage");
mkdirSync(dest, { recursive: true });
for (const f of files) {
	copyFileSync(f, join(dest, f));
	console.log(`copied ${f} -> ${join(dest, f)}`);
}
console.log("\nDone. In Obsidian: Settings -> Community plugins -> enable \"Idea Triage\".");
console.log("(If the plugin was already enabled, reload Obsidian with Ctrl+R.)");
