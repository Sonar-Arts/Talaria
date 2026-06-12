---
name: obsidian-idea-triage-configuration
description: Configure the obsidian-idea-triage plugin for a specific Obsidian vault, local LLM server, and GitHub repository
source: auto-skill
extracted_at: '2026-06-11T02:07:50.036Z'
---

# Configure obsidian-idea-triage

## Files to modify

1. **`scripts/install-vault.mjs`** — Change `DEFAULT_VAULT` to your Obsidian vault path
2. **`src/settings.ts`** — Update `DEFAULT_SETTINGS` object with your LLM and repo values

## Configuration values

| Setting | File | Property |
|---|---|---|
| Vault path | `scripts/install-vault.mjs` | `DEFAULT_VAULT` |
| LLM base URL | `src/settings.ts` | `DEFAULT_SETTINGS.llmBaseUrl` |
| LLM model name | `src/settings.ts` | `DEFAULT_SETTINGS.llmModel` |
| GitHub repo | `src/settings.ts` | `DEFAULT_SETTINGS.repo` |

## LLM servers

| Server | Base URL | Example model |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | `qwen2.5:7b-instruct` |
| LM Studio | `http://localhost:1234/v1` | `llama-3.2:latest` |
| llama_server | `http://localhost:8000/v1` | `gemma 4` |

## Install to vault

```bash
npm run install:vault
```

This runs `npm run build` then copies `main.js`, `manifest.json`, `styles.css` to the vault's `.obsidian/plugins/idea-triage/` directory.

## Verify in Obsidian

1. **Settings → Community plugins** → enable **Idea Triage**
2. If already enabled, reload with **Ctrl+R**
3. **Settings → Idea Triage** — confirm values are pre-filled
4. Press **Test** under *Test LLM* and *Test gh* to verify connectivity
