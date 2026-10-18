# AI Release Notes 🏷️🤖

[![Test & Dry-Run Release Notes](https://github.com/marketplace/actions/ai-release-notes/workflows/Test%20&%20Dry-Run%20Release%20Notes/badge.svg)](#)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-AI%20Release%20Notes-blue.svg?logo=github)](https://github.com/marketplace/actions/ai-release-notes)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An intelligent, production-ready GitHub Action that automatically drafts and categorizes release notes whenever a GitHub Release is published. It aggregates commits between release tags, summarizes and organizes them using an OpenAI-compatible LLM, and idempotently prepends them to your release description.

If no LLM key is provided or the LLM service is unreachable, it automatically falls back to clean, structured bullet points of your commit history so your release pipeline **never breaks**.

---

## ✨ Features

- **Automated Commit Comparison**: Automatically detects the previous tag (sorted by creation date) and compares commits. If it's your repository's first release, it analyzes up to the 200 most recent commits on your default branch.
- **AI-Powered Categorization**: Transforms raw, cryptic git messages into polished release notes grouped into Features, Bug Fixes, and Chores using an OpenAI-compatible endpoint (OpenRouter, OpenAI, Groq, etc.).
- **Zero-Failure Fallback**: If `llm-api-key` is not configured or an API error occurs, gracefully degrades to a clean bulleted list of commit subjects.
- **Idempotent Updates**: Prepends notes above existing release content under a `<!-- ai-release-notes -->` marker. If the marker is already present in the release body, subsequent runs safely skip updating.
- **Flexible Triggers**: Designed for `release: [published]`, but supports manual execution via `workflow_dispatch` with an optional `tag` input for testing or backfilling.
- **Dry-Run Mode**: Allows testing in CI and Pull Requests without mutating any releases.
- **Strict Security**: API tokens and secrets are automatically masked with `core.setSecret` to prevent accidental credential leakage in workflow logs.

---

## 🚀 Quick Start (Copy-Paste Workflow)

Create a workflow file at `.github/workflows/release-notes.yml` in your repository:

```yaml
name: 'AI Release Notes'

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag name to generate release notes for (optional, defaults to latest)'
        required: false
        type: string

permissions:
  contents: write

jobs:
  generate-notes:
    runs-on: ubuntu-latest
    steps:
      - name: Generate AI Release Notes
        uses: your-username/ai-release-notes@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          tag: ${{ github.event.inputs.tag }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: 'https://openrouter.ai/api/v1'
          llm-model: 'openrouter/free'
```

> **Note**: In external repositories, replace `your-username/ai-release-notes@v1` with your published repository path and version tag.

---

## ⚙️ Inputs

| Input | Description | Required | Default |
| :--- | :--- | :---: | :--- |
| `github-token` | GitHub token for reading commits, tags, and updating the release. | No | `${{ github.token }}` |
| `tag` | Target release tag name to summarize. If omitted, automatically determined from the release event or latest release/tag. | No | `""` |
| `llm-base-url` | Base URL for the OpenAI-compatible `/chat/completions` endpoint. | No | `https://openrouter.ai/api/v1` |
| `llm-model` | Model identifier to use for summarization. | No | `openrouter/free` |
| `llm-api-key` | API key for the LLM service. Passed as a secret. If omitted, triggers the fallback bullet list. | No | `""` |
| `dry-run` | When set to `'true'`, generates and outputs notes without modifying the GitHub Release body. | No | `'false'` |

---

## 📤 Outputs

| Output | Description |
| :--- | :--- |
| `notes` | The generated markdown release notes string. |
| `release-updated` | Whether the GitHub Release body was updated (`true` or `false`). |

---

## 🔒 Required Permissions

This action updates your repository's Release body using the GitHub REST API. You must grant the workflow write access to repository contents:

```yaml
permissions:
  contents: write
```

If your repository has restricted default permissions (`GITHUB_TOKEN` set to read-only), the workflow will fail with a 403 error unless `contents: write` is explicitly declared.

---

## 🛡️ LLM Fallback Behavior & Reliability

Release automation should be bulletproof. **AI Release Notes** is engineered with multiple safety nets:

1. **Missing API Key**: If `llm-api-key` is not provided or empty, the action logs a clear warning and generates a clean bulleted list of commits (e.g. `- feat: added dark mode (a1b2c3d)`).
2. **API Outages & Timeouts**: If the configured LLM endpoint times out, encounters rate limits, or returns an HTTP error, the error is logged and the bulleted list fallback is immediately used.
3. **Empty Commit Range**: If no commits exist between tags, the action cleanly sets the notes to `### Summary\n\nNo changes since last release.` without failing.
4. **Idempotency**: Before performing any release update, the action checks if the `<!-- ai-release-notes -->` marker is already present in the release body. If present, the update is safely skipped.
5. **Credential Masking**: The action registers `llm-api-key` and `github-token` with GitHub Actions secret masking so they will never appear in console logs.

---

## 🧪 Testing in Pull Requests (Dry-Run)

You can run this action safely in your CI pipeline on pull requests using `dry-run: 'true'`:

```yaml
name: Test Action
on: [pull_request]

jobs:
  dry-run-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          dry-run: 'true'
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

---

## 💬 Support

If you have questions, feedback, bug reports, or feature suggestions, please reach out to:

📧 **Support**: `SUPPORT_EMAIL_PLACEHOLDER`
