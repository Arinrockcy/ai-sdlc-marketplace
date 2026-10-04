---
name: goal-workflow
description: Triage every task as simple or complex with the user, and run a complex task as a governed goal. Plan it into ordered sub-tasks, get the user's approval, then implement, review, verify and commit one sub-task at a time, tracked in a ledger under .agent-goals/. Use before starting any task, and to resume a goal from its ledger.
---

# goal: goal-workflow

Read and follow the project's own instruction files (such as `AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`, and whatever they point to) before using this workflow. They are the rules every step below is held to. This workflow adds triage, a plan, gates and a ledger; it replaces none of the project's rules.

Where a path in this skill still starts with an unexpanded variable, that variable stands for this plugin's folder: two levels above the folder that holds this SKILL.md.

This workflow keeps its state in a ledger under `.agent-goals/` and is separate from the `aisdlc` plugin's `.aisdlc/` state: neither reads or changes the other.

The session the user is talking to is the **orchestrator**. It asks the user the questions, hands work to the roles, keeps the ledger, and evaluates the commit gate. It does not implement or review complex work itself.

## Rules that hold in every step

- **Never assume.** Anything the request, the code or a referenced document does not settle is a question for the user. This applies to simple tasks too.
- **Ask with options.** Put every question and decision to the user as a choice between concrete options (with a structured question tool where the agent has one), with the recommended option marked and a one-line consequence for each. Group related questions into one round rather than asking one at a time.
- **Record every answer** in the ledger's decision log with its date, so it is not asked again in a later session or after the session is cleared.
- **Only the user changes scope.** Work discovered part-way that is not in the approved sub-task comes back as a question. It is not done silently and not dropped silently.
- **Work owned elsewhere is a question.** Work that belongs to another repository or another owner is reported to the user as a question, never done and never dropped silently. If the project's instructions have hand-off rules, follow them.
- **Clear context before new work.** Whenever the next thing to start does not need the context of the current session, first make sure the ledger is up to date, tell the user that the next step needs none of the current context, and stop until they clear the session or start a fresh one (in Claude Code, `/clear`), or say to continue without clearing. Then resume from the ledger, as under Resuming. Check this at four points: before a new goal or an unrelated task; after plan approval, before the first sub-task; between sub-tasks, once one is committed; and when the goal closes. A sub-task whose commit is outstanding is not such a point.
- **Never push unasked.** The orchestrator and the roles never push on their own. Commits stay local until the user explicitly asks for a push.

## Roles

Four roles do the work: `planner`, `governor`, `implementer` and `reviewer`. The planner, the governor and the reviewer are read-only: they never edit, stage, commit or revert anything in the project.

- Where the agent has named plugin agents (Claude Code), spawn them as `goal:planner`, `goal:governor`, `goal:implementer` and `goal:reviewer`, in the background where the agent supports it, so the orchestrator stays free to talk to the user.
- Where it has sub-agents but no named plugin agents, read the role's file at `${CLAUDE_PLUGIN_ROOT}/agents/<role>.md` and hand a generic sub-agent its full text as instructions.
- Where it has no sub-agents, run the roles one at a time in the current session, each following that same role file, with the same steps, gates and questions. The review is the exception: ask the user to start a fresh session for it and run the reviewer there from the ledger and the uncommitted diff, so the reviewer does not share the implementer's context.

Start new role agents for each sub-task and give them the ledger. An agent is resumed only within the same sub-task, for its fix rounds and its commit; it is never carried over to the next sub-task.

A role does not see this skill's folder or the conversation. Pass each one everything it needs:
- the ledger's path, and which sub-task it is working on
- the project commands recorded in the ledger
- the decisions already made, and the governor's notes for the sub-task
- the unrelated changes in the working tree it must leave alone
- any template text it needs, written out in full
- for the reviewer, a scratch folder outside the project for its repro files

A role that meets something undecided finishes what does not depend on it and returns the rest under **Questions for the user**, with options and a recommendation. The orchestrator asks the user. A role never asks the user itself and never decides for them.

## Step 0: Triage (every task)

Before doing anything else, say whether the task looks **simple** or **complex**, with a one-line reason, and ask the user to choose. Nothing starts until they answer. If the session has already done other work and the task is a new goal or unrelated to it, apply "Clear context before new work" first.

- Recommend **simple** for read-only answers, explanations, reviews, and small self-contained edits in one area that change no shared interface, data model or agreement with another system.
- Recommend **complex** for work that spans several files, modules or packages; changes a shared interface, a public API, a data model or a schema; needs work in another repository or from another owner; or implements a phase or a task document.

A simple task is done directly in the current session under the project's rules, and the workflow ends here. A complex task continues below.

## Step 1: Goal

Hand the request, and every document it names, to the `planner`. It returns a draft:
- one main goal: what done looks like, and what is out of scope
- an ordered list of sub-tasks, each with its scope, files or areas, acceptance checks that can be run, whether it changes a screen, its dependencies, and the task document it came from, if any
- the project's commands for tests, lint, build, project-specific validation and the browser check, found in the project's instructions, package scripts, Makefile and CI configuration, each with where it was found, or "not found"
- the open questions it could not settle

Ask the user the planner's questions. Then write the ledger at `.agent-goals/<slug>.md` in the project, where `<slug>` is a short name of lowercase letters, digits and hyphens, from the template `ledger-template.md` next to this SKILL.md, with status `draft`. The ledger is not committed on its own: it first travels in the first sub-task's commit.

## Step 2: Govern the plan

1. Hand the ledger to the `governor` in **plan** mode. It checks every sub-task against the project's instruction files and returns, per sub-task: the rules that apply, any conflict with them, whether part of the work belongs to another repository or owner, whether the acceptance checks can be run and are enough, and whether the order and dependencies are sound.
2. Fold its findings into the ledger and ask the user about anything it raised.
3. **Plan approval gate.** Show the user the goal and the sub-tasks and ask them to approve, edit or reject the plan. No implementation starts before approval. An edited plan goes back through the governor (item 1) before approval is asked again. A rejected plan sets the goal to `abandoned`, and the workflow ends. In the same round, ask, once per goal:
   - **Project commands:** confirm or correct each command the planner found. A command the project does not have is recorded as "none", which waives its gate condition for the whole goal. Say plainly in the question which gate conditions will therefore not be checked, so that, for example, a goal with no test command is the user's explicit choice. The browser check is the exception: recorded as "none", it is still asked about at every sub-task that changes a screen.
   - **Branch:** work on a new branch (and its name) or on the current branch.
   - **Commits:** commit each sub-task automatically once its gate holds, or ask before each commit.
   - **Fix loop:** send clear defects back to the implementer automatically for up to 2 rounds, or ask the user after every review.

   Record the approval and each answer in the ledger, and set the goal to `approved`. If the user chose a new branch, the orchestrator creates it now, before the first sub-task. If the working tree has uncommitted changes at that moment, list them and ask whether they come along to the new branch or the user deals with them first.
4. Record the test baseline in the ledger: the commit it was measured on and which tests already fail there, from running the project's test command once. The planner or the governor may measure it. With a test command of "none", record that there is no baseline.
5. The plan is approved and the ledger holds everything the sub-tasks need. Apply "Clear context before new work" before the first sub-task.

## Step 3: Run sub-tasks one at a time, in the approved order

Never run two sub-tasks at once, and never start one whose predecessor is not `done` or `dropped`. Only the user drops a sub-task: when they do, set it to `dropped` with their reason and record the decision. Set the goal to `in-progress` when the first one starts. For each sub-task:

1. **Implement.** Set it to `in-progress`. Hand the `implementer` the sub-task's ledger entry, the governor's notes and the decisions already made. It finishes everything that does not depend on an open question, leaves the unclear part undone, and returns its questions with options. Ask the user, then give the answers to the same implementer (resume that agent where the agent supports it; otherwise start a new one with the earlier report and the answers).
2. **Review and govern.** When the implementer reports done, set the sub-task to `in-review` and hand the uncommitted diff to the `reviewer` and to the `governor` in **check** mode. The reviewer hunts for defects and regressions. The governor checks the diff against the project's rules and checks that it stayed inside the approved scope. Both are read-only.
3. **Fix loop.** Follow the goal's recorded choice:
   - *Automatic:* clear defects and rule violations go back to the implementer without asking, and the fix pass is reviewed again. After 2 fix rounds without a pass, stop and ask the user how to proceed.
   - *Ask:* show the user the findings after every review and ask which to fix.

   Under either choice, a finding that is a product or scope decision is asked, never fixed on the orchestrator's own judgment.
4. **Commit gate.** All of these must hold on the final diff:
   - the reviewer's verdict is safe to commit
   - the governor reports no rule or scope violation
   - the project's test command fails nothing beyond the recorded baseline
   - the project's lint command is clean
   - the project's build succeeds
   - the project-specific validation passes
   - for a sub-task that changes a screen, a browser check exercised the change

   A condition whose command is recorded as "none" is waived, except the browser check. If a sub-task changes a screen and the browser check cannot be run, or none is recorded, stop and ask the user whether to commit without it, wait, or check it themselves. Never skip it silently.
5. **Task detail.** When the gate holds, set the sub-task to `done` in the ledger with the review verdict and the verification results. If the sub-task came from a task document (its **Source document** in the ledger), append a `## Task detail` section at the end of that document, or add to the one already there, covering:
   - what was done and what was not done, with the reason for anything deferred
   - the files changed, and every decision made for the sub-task with its date and who made it
   - the review findings and fix rounds, the governor's verdict, and the verification results against the baseline, including what was not verified
   - the commit, and the follow-ups: hand-offs waiting on someone else, and open questions

   A sub-task with no source document keeps this detail in its ledger entry.
6. **Commit.** Follow the goal's recorded choice: commit now, or ask the user first. If the user declines the commit, the sub-task stays `done` with its commit outstanding (note that in its ledger entry), and the next sub-task does not start until it is committed or the user says otherwise. Otherwise have the implementer make **one commit** for the sub-task: files staged by explicit path, the ledger and the source task document included, unrelated user changes left out, in the project's commit message style with the attribution the agent's host requires, and not pushed. Record the commit hash in the ledger and in the task detail afterwards; that edit travels in the next commit.
7. Report the outcome to the user in a few lines. Once the sub-task is committed and its hash is in the ledger, apply "Clear context before new work", then move to the next sub-task.

If the gate cannot be met, set the sub-task to `blocked` with the reason and ask the user. Do not start the next sub-task around a blocked one unless the user says to. The user may also abandon the goal at any point: set it to `abandoned` with their reason and stop.

## Step 4: Close the goal

When every sub-task is `done` or `dropped`, set the goal to `done`. Then have the implementer make the closing commit, following the goal's recorded commit choice (commit now, or ask the user first): the final ledger update, and the last sub-task's source task document when its commit hash was written there after that sub-task's commit. Report what shipped, what was deferred and why, the hand-offs waiting on another repository or owner, and what was not verified. Then apply "Clear context before new work": nothing that follows needs this session.

## Resuming

In a new session, or after the session was cleared, read the ledger for the goal the user names, or list `.agent-goals/` and ask which one. Use the branch, the project commands and the commit and fix-loop choices the ledger records, and do not ask again for a decision already in its log. If the current branch is not the one the ledger records, or that branch does not exist yet, ask the user before doing anything else. Where to continue depends on what the ledger says:

- Goal `draft`: at step 2, from the governor's plan check. The approval gate, the once-per-goal questions and the baseline are all still to come.
- Goal `approved` with no test baseline recorded: at step 2, item 4.
- Goal `abandoned`: nothing to continue. Say so.
- Goal `done`: if the ledger's last update is not committed, the closing commit is outstanding (step 4). Otherwise there is nothing to continue.
- Goal `in-progress` and every sub-task `dropped` or `done` with its commit hash recorded: at step 4.
- Otherwise, at the first sub-task, in order, that is neither `dropped` nor `done` with its commit hash recorded:
  - `done` with no commit hash: check the project's history first. If it already holds the sub-task's commit, record that hash and look at the next sub-task. If not, the commit is outstanding: continue at the commit step (step 3, item 6).
  - `in-progress`: at the implement step, on the working tree as it is. Tell the implementer that earlier work on the sub-task may already be there.
  - `in-review`: at the review step, on the uncommitted diff as it is.
  - `blocked`: ask the user how to proceed, with the recorded reason.
  - `pending`: start it at the implement step.

Never skip a gate because an earlier session may have passed it. What the ledger does not record as done is still to do.

## Ledger statuses

- Goal: `draft`, `approved`, `in-progress`, `done`, `abandoned`.
- Sub-task: `pending`, `in-progress`, `in-review`, `blocked`, `done`, `dropped`.

Only the user drops a sub-task or abandons the goal; `dropped` counts like `done` for the order of sub-tasks and for closing the goal.

Only the orchestrator edits the ledger and writes the task detail. The implementer only stages both in a commit.
