# Idea Triage

An Obsidian plugin that turns the ideas buried in your notes into GitHub issues — with a local LLM doing the reading and you keeping the final say on every change.

**Flow:** select notes → a local LLM extracts and categorizes the ideas in them → it compares those ideas against the open issues of a GitHub repository → it proposes actions (create issue, edit title/body, comment, add/remove labels) → you review each proposal in a side panel, edit inline, and discuss revisions with the AI in a chat — nothing touches GitHub until you approve it and press **Apply**.

## Requirements

- **Desktop only** (the plugin spawns the `gh` CLI and uses Node networking).
- **[GitHub CLI](https://cli.github.com/)** (`gh`) installed and authenticated (`gh auth login`). No token is stored by the plugin.
- A **local LLM server with an OpenAI-compatible API**, e.g.:
  - [Ollama](https://ollama.com/) — base URL `http://localhost:11434/v1`
  - [LM Studio](https://lmstudio.ai/) — base URL `http://localhost:1234/v1`
  - llama.cpp `llama-server`, vLLM, etc.

  A capable instruct model (e.g. `qwen2.5:7b-instruct` or better) is recommended; the plugin's JSON parsing is forgiving, but very small models struggle with the matching step.

## Setup

1. Install the plugin (see **Development** below) and enable it under **Settings → Community plugins**.
2. Open **Settings → Idea Triage**:
   - **Base URL / Model / API key** — point at your local server. Press **Test** to verify the connection.
   - **Repository** — `owner/repo` to triage against, or press **Pick** to choose from your repos.
   - **gh executable** — leave as `gh` if it is on your PATH.
   - Press **Test** under *Test gh* to confirm the CLI is installed and authenticated.
3. Optional limits: max issues fetched, extraction chunk size (lower it for small-context models), idea dedupe.

## Usage

1. Run **Idea Triage: Analyze notes** (ribbon icon or command palette).
2. Pick notes and/or folders in the searchable multi-select picker.
3. The triage panel opens in the right sidebar:
   - **Proposal cards** show the action kind, content, and the model's rationale. Approve with the checkbox, expand to edit the title/body inline, or reject.
   - **Chat** below the cards: discuss the proposals ("merge p1 and p3", "make the tone more formal", "that one already exists, drop it"). When the model revises the list, changed cards reset to *pending* for re-approval, replaced edits get a **revert** badge, and dropped items are soft-rejected — never silently deleted.
4. Press **Apply (n)** to run the approved actions sequentially via `gh`. Missing labels are detected first, with an offer to create or drop them. Each card shows *applied* (with the new issue number) or *failed* with the error.

The session — ideas, proposals, statuses, and chat — is saved automatically and restored when Obsidian restarts. Use the **Clear** button in the panel toolbar to discard it.

### How chat revisions work

Each chat turn the model receives the current proposal list as JSON inside its system prompt. It replies in prose, and when changes are warranted it appends a fenced ` ```proposals ` block containing the complete revised list. The plugin hides that block from the chat bubble, diffs it against the store by proposal id, and shows a summary pill ("Proposals updated: 1 added, 2 changed"). Malformed blocks trigger one automatic retry.

## Development

```bash
npm install
npm run dev            # esbuild watch -> main.js
npm run build          # type-check + production build
npm run install:vault  # build, then copy main.js/manifest.json/styles.css into the vault
```

`scripts/install-vault.mjs` needs to know where your vault is. Pass the path as the first argument, or set the `OBSIDIAN_VAULT` environment variable:

```bash
npm run install:vault -- "/path/to/Your Vault"
# or
OBSIDIAN_VAULT="/path/to/Your Vault" npm run install:vault
```

The target must contain a `.obsidian` folder. Files are copied rather than junction-linked so cloud-synced vaults don't pick up `node_modules`.

Smoke-test the pure JSON-parsing logic without Obsidian:

```bash
npx esbuild src/llm/json-utils.ts --bundle --platform=node --format=cjs --external:obsidian --outfile=.tmp-json-utils.cjs && node scripts/smoke-test.mjs
```

### Architecture

```
src/
├── main.ts                  # plugin class: commands, data persistence, pipeline orchestration
├── settings.ts              # settings tab incl. "Test LLM" / "Test gh" buttons
├── types.ts                 # Idea, IssueRef, Proposal, ProposalAction, PersistedSession
├── llm/
│   ├── transport.ts         # OpenAI-compatible chat completions over Node http(s), streaming + abort
│   ├── json-utils.ts        # tolerant JSON extraction/repair, validators, retry wrapper
│   ├── prompts.ts           # extraction / matching / chat prompts
│   └── pipeline.ts          # chunk notes -> extract ideas -> match issues -> propose actions
├── gh/gh-client.ts          # gh CLI wrapper (spawn, --body-file for multi-line bodies)
├── state/
│   ├── proposal-store.ts    # single source of truth; diff/merge of chat revisions
│   └── session.ts           # one triage run: notes, ideas, issues, chat, store
└── ui/                      # triage view, proposal cards, note/repo pickers, confirm modal
```

## License

MIT
