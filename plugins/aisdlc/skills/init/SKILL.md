---
name: init
description: Initialize the AI-SDLC workflow in the current project. Creates .aisdlc/ (goals state folders, registry.md, governance.md, config.json, adr/, stacks/, cache/), detects the tech stack, registers a stack plugin, optionally sets up Graphify, and offers to set up governance rules. Use when the user runs /aisdlc:init or wants to start using the aisdlc workflow in a repo.
argument-hint: "[--base-branch <branch>]"
---

# aisdlc: init

`$AISDLC` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/aisdlc.mjs"`. Run every command from the project root. The script prints JSON. Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md. Skills are named `<plugin>:<skill>` (`/aisdlc:govern`, `aisdlc-nodejs:nodejs-standards`); in an agent without plugin namespaces, such as GitHub Copilot, use only the `<skill>` part, both to load a skill and when you tell the user what to run (`/aisdlc:govern` is `/govern`, `aisdlc-nodejs:nodejs-standards` is `nodejs-standards`).

**Don't assume.** If something this step needs is unclear, missing or under-documented, and neither the code nor the `.aisdlc/` files answer it, ask the user. Never fill a gap with a guess or a silent default. Detected values (stack, base branch, package manager) are suggestions: confirm them with the user.

Init is idempotent. It only creates what is missing and never overwrites existing files, so it is safe to re-run.

## Steps

1. **Scaffold.** Run `$AISDLC hooks run pre_init`. On a first init only the env override and core default apply, because `.aisdlc/config.json` doesn't exist yet. Then run `$AISDLC init` (pass `--base-branch <b>` if the user gave one after the skill's name: `$ARGUMENTS`).
   Report the `created` list. If it is empty, tell the user the workflow was already initialized and continue with the checks below. Change only what they ask to change.

2. **Base branch.** Show `git.base_branch` from the JSON output (default `develop`). Ask the user to confirm it or give another name. If it changes, run `$AISDLC config set git.base_branch <name>`.

3. **Stacks.** Run `$AISDLC detect-stack`. It finds the project's languages from marker files, including the markers each installed stack plugin declares, and lists them in `detected`. Every detected stack with a registered manifest is active, so a repository can have several. Leave `stack` in `.aisdlc/config.json` at `auto`: a stack plugin installed later is then picked up by `/aisdlc:create-goal` and `/aisdlc:implement` without changing the config.
   - **`to_register`:** the language was detected and its plugin is installed, so don't ask whether to use it. For each entry, one at a time, invoke its `register_skill` (without plugin namespaces, the part after the `:`). If the agent has no skill of that name, the plugin is installed for another agent: treat the stack as one in `without_plugin`.
   - **`without_plugin`:** tell the user that no aisdlc plugin for that stack is installed. They can install `aisdlc-<stack>` from the aisdlc marketplace, and the workflow picks it up by itself, or continue without it: core default hooks apply, with no stack standards. They can also set their own hooks in `.aisdlc/config.json`.
   - **Nothing detected:** ask the user which stack the project uses, or whether to keep `auto`. If they name one, run `$AISDLC config set stack <name>`, run `$AISDLC detect-stack` again, and register it as above if it is now in `to_register`.

   After the register skills return, check that the workflow uses what they installed, because a register skill can't run this script:
   1. Run `$AISDLC detect-stack`. Each registered stack must be in `active`, with `manifest_installed` true in `stacks`. If one isn't, its marker is missing from the project root: run `$AISDLC config set stack <name>` with every stack that should apply (a JSON list for several, such as `["nodejs","python"]`) and check again.
   2. Run `$AISDLC hooks resolve after_task`. Its `source` should be `stack`, with the commands of every active stack's manifest. If `source` is `env`, tell the user that `AISDLC_HOOK_AFTER_TASK` in their environment replaces the stacks' gate for as long as it is set. If it is `config`, show the override in `.aisdlc/config.json` and ask whether to keep it or remove it with `$AISDLC config set hooks.after_task '{"use":"stack"}'`. If `commands` is empty, say that no task gate will run.

4. **Knowledge graph.** Ask the user to choose one:
   - **Graphify (recommended for larger codebases).** A code graph that later steps query instead of searching and reading files, which saves tokens. The workflow runs it code-only: local parsing, no model calls, no API key.
     1. Run `$AISDLC graph status`. If `installed` or `supported` is false, show the `install` hint. Offer to run an install command, only with the user's approval. The workflow needs only the `graphify` CLI, not `graphify install`.
     2. Run `$AISDLC graph setup`. It adds `.aisdlc/` to `.graphifyignore`, sets `graph.provider` to `graphify` and builds the graph in `graphify-out/`, which takes seconds on a large codebase. From then on, `$AISDLC graph query "<keywords>"` refreshes the graph whenever the code has changed. Pass identifiers and domain words (function, file or module names), not a sentence: the graph matches names, not prose.
     3. If setup returns `warnings`, show them to the user. They name files Graphify left out of the graph, often with the install that fixes it (for example its SQL extra). Offer to run that install, only with the user's approval, then run `$AISDLC graph setup` again to rebuild with those files.
   - **No graph.** Run `$AISDLC config set graph.provider none`. Skills then find code by searching and reading files directly. `.aisdlc/registry.md` is still kept either way, but it indexes goals and ADRs, not code, so it doesn't replace a graph.

5. **Git hygiene.** `.aisdlc/` is meant to be committed; `.aisdlc/cache/` ignores itself. If Graphify was chosen, suggest adding `graphify-out/` to `.gitignore` and committing `.graphifyignore`. Do this only if the user agrees.

6. **Governance.** Run `$AISDLC governance list` and show the user the rules. A new project starts with:
   - GOV-01 to GOV-05, `plan` rules that `/aisdlc:govern <G-id>` checks before implementation
   - GOV-06, a `final` rule: the finished code meets every acceptance criterion of the goal and of each done task. `/aisdlc:implement` runs this final review before a goal completes.

   Without any active `final` rule, nothing reviews the finished code: a goal completes as soon as every task's verify passes. If the list has no active `final` rule (for example, a project initialized before aisdlc 0.3.0), tell the user that.
   Then ask whether to set up the project's own rules now (tests, secrets, stack standards and the other catalog rules). If they agree, run `/aisdlc:govern` with no argument. Otherwise tell them they can run it any time before their first goal is governed.

7. Run `$AISDLC hooks run post_init`. Summarize: the resolved config (`$AISDLC config get`), the active hooks (`$AISDLC hooks list`, showing only points that have commands), the governance rules, and the next step, `/aisdlc:create-goal <description>`.
   Point out that by default, before a goal completes, `after_goal` checks the coverage report the stack declares and then pushes the goal's branch to `origin`. It never pushes the base branch: a goal built on it isn't pushed. To keep the check but not push, set `hooks.after_goal` to `{"run": "{aisdlc} coverage check {goal_id}"}` in `.aisdlc/config.json`. To turn off both, set it to `null`.

## Hook overrides (for the user's reference)
Precedence for each hook point: env `AISDLC_HOOK_<POINT>` > `.aisdlc/config.json` `hooks` > `.aisdlc/stacks/<stack>.json` > core defaults.
Hook commands can use `{base_branch}`, `{branch_prefix}`, `{goal_id}`, `{goal_slug}`, `{goal_branch}`, `{task_id}`, and `{aisdlc}` (this script, run with the same Node).
Values can be `{"run": "<cmd>"}`, `{"run": ["a", "b"]}`, `{"use": "stack"}`, `{"use": "default"}`, or `null` (disabled). An env value can be a command, `none`, `use:stack` or `use:default`.
