---
name: init
description: Initialize the AI-SDLC workflow in the current project. Creates .aisdlc/ (goals state folders, registry.md, governance.md, config.json, adr/, stacks/, cache/), detects the tech stack, registers a stack plugin, and optionally sets up Graphify. Use when the user runs /aisdlc:init or wants to start using the aisdlc workflow in a repo.
argument-hint: "[--base-branch <branch>]"
---

# aisdlc: init

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run every command from the project root. The script prints JSON.

Init is idempotent. It only creates what is missing and never overwrites existing files, so it is safe to re-run.

## Steps

1. **Scaffold.** Run `$AISDLC hooks run pre_init`. On a first init only the env override and core default apply, because `.aisdlc/config.json` doesn't exist yet. Then run `$AISDLC init` (pass `--base-branch <b>` if the user gave one in `$ARGUMENTS`).
   Report the `created` list. If it is empty, tell the user the workflow was already initialized and continue with the checks below. Change only what they ask to change.

2. **Base branch.** Show `git.base_branch` from the JSON output (default `develop`). Ask the user to confirm it or give another name. If it changes, run `$AISDLC config set git.base_branch <name>`.

3. **Stack.** Run `$AISDLC detect-stack`.
   - If `detected` has exactly one stack, ask the user to confirm it.
   - If it has several, ask the user which one should be the primary stack.
   - If it has none, ask the user to name the stack, or keep `auto`.
   Save the answer with `$AISDLC config set stack <name>`.
   Then check whether a skill named `aisdlc-<stack>:register` is available:
   - **Available:** invoke it. It installs `.aisdlc/stacks/<stack>.json` (standards skill and hook overrides).
   - **Not available:** tell the user that the stack plugin `aisdlc-<stack>` is not installed. They can install it from the aisdlc marketplace, or continue without it. Without it, core default hooks are used and there are no stack standards. They can also set their own hooks in `.aisdlc/config.json`.

4. **Knowledge graph.** Ask the user to choose one:
   - **Graphify (recommended for larger codebases).** It builds a code knowledge graph so later steps read less. Install it with `pip install graphifyy && graphify install` (needs Python 3.10+), then build the graph with `/graphify .`. Offer to run the install command, but only with the user's approval. Then run `$AISDLC config set graph.provider graphify`. Graphify writes to `graphify-out/`. If the user's output path differs, run `$AISDLC config set graph.path <dir>`.
   - **registry.md only.** Run `$AISDLC config set graph.provider none`. Skills then rely on `.aisdlc/registry.md` as the index.

5. **Git hygiene.** `.aisdlc/` is meant to be committed; `.aisdlc/cache/` ignores itself. If Graphify was chosen, suggest adding `graphify-out/` to `.gitignore`. Do this only if the user agrees.

6. Run `$AISDLC hooks run post_init`. Summarize: the resolved config (`$AISDLC config get`), the active hooks (`$AISDLC hooks list`, showing only points that have commands), and the next step, `/aisdlc:create-goal <description>`.

## Hook overrides (for the user's reference)
Precedence for each hook point: env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` `hooks` > `.aisdlc/stacks/<stack>.json` > core defaults.
Values can be `{"run": "<cmd>"}`, `{"run": ["a", "b"]}`, `{"use": "stack"}`, `{"use": "default"}`, or `null` (disabled). An env value can be a command, `none`, `use:stack` or `use:default`.
