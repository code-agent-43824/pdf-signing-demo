# AGENTS.md — rules for coding agents

The owner's canonical rules, shared by all of his projects. Copy this file into a
repository as is; project-specific material goes in the [Appendix](#appendix--what-to-add-per-project).

## 0. How the rules are organised

- **`AGENTS.md` is the single source of rules**, read by every agent: Claude Code, Codex, Copilot, Gemini.
- **`CLAUDE.md`, `.github/copilot-instructions.md` and `GEMINI.md` never restate the
  rules.** They hold an import of this file plus a map of the code — architecture, commands,
  pitfalls, what is *not* here. Two copies drift, and the stale one gets followed.
- **Project rules extend this file; they never override it.** A necessary departure is
  stated with its reason under "Departures" in the project's `AGENTS.md`; a silent one
  is a mistake.
- **This file is copied unchanged and never edited in place**, so a repository's documentation
  checks must exclude it — it names files (`.github/copilot-instructions.md`) a project may lack.
- If the owner asks otherwise on a task, that is his call — no rule broken, no change to this file.

## 1. Git

- **One working branch — the repository's trunk** (`main`, or `master` in older
  repositories; same thing). **No branches, no pull requests.**
- **Each completed logical step is its own commit, pushed immediately.** Do not pile
  work into one large commit or mix unrelated changes.
- **The trunk is always green.** A commit that breaks the build, the tests or the linter does not go in.
- **A red trunk outranks your own task.** Broke it yourself — fix it now. Someone else
  broke it — tell the owner and get his go-ahead first, since another agent may be on
  it already. Ask immediately: this comes before the work you arrived to do.
- **`git fetch` before starting** — the local trunk may be behind another agent's work.
- **Before committing, run `git diff --check` and `git status`** — no stray temp, generated or other agents' files.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
  in English:** `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `ci:`, `test:`. Say what
  and why; the message stands without the diff.
- **Use plain git commands.** The GitHub API is for reading only — statuses, logs, releases, artifacts.

## 2. Project documents

Six documents, each answering one question. **A fact lives in exactly one of them** — when unsure, this table decides.

| Document | Answers | How it lives |
| --- | --- | --- |
| `docs/ROADMAP.md` | **Where we are going** — the product, its stages, their order | Long-lived; changes rarely |
| `docs/PLAN.md` | **What we are doing in the current stage** — actions with `[ ]` / `[~]` / `[x]` / `[!]` | Rewritten when the stage closes |
| `docs/STATUS.md` | **What state the project is in now** — what works, what is broken, version, where work stopped | One screen; overwritten |
| `docs/WORKLOG.md` | **What we did** — one entry per chunk: plan → done → next | Append-only, newest on top |
| `docs/JOURNAL.md` | **What we learned** — hypothesis → what we did → what the check showed → conclusion | Append-only, newest on top |
| `HANDOFF.md` | **What is unfinished right now** — in-flight work and the exact next step | Overwritten; says so when nothing is in flight |

`AGENTS.md` and `HANDOFF.md` sit in the repository root and are read first; the rest lives in `docs/`.

**`WORKLOG` vs `JOURNAL`** is the easy one to get wrong. Worklog is operational — what I set out
to do, did, and have left, so interrupted work can be picked up; a typo fix belongs there. Journal
is about knowledge: a hypothesis tested on hardware, the cause of a bug, a settled question.

- **Never delete failed attempts from `JOURNAL`.** Each closes off a hypothesis you would return to.
- **`STATUS` and `HANDOFF` do not update themselves.** Checked or changed the real state — reconcile them in the same session.
- **Overwrite another agent's `HANDOFF` entry only once that work is finished.** Unfinished work
  is never erased — carrying it is why the file exists. Cannot tell? Treat it as unfinished.
- **What is not written down was not started.**
- **When code and documentation disagree, fix the documentation in the same change.**
- **State lives only in `STATUS`, `HANDOFF` and the project's defect list** where it keeps one.
  `ROADMAP`, `PLAN`, `CLAUDE.md`, `README` and design documents say how it is built and why, never
  what currently works: **a slow document never says "X is / is not implemented"**. That sentence
  goes stale the moment X ships, nobody greps slow documents mid-feature, and the next agent
  believes it. Link to `STATUS` instead.
- **A fact that already exists in code is referenced by name, not copied by value** — name the
  constant or the file; a value retyped into prose is a second copy, and it drifts.
- **A document must not contradict itself.** Edited a status line — read the rest of the file.
- **Where a fact can be checked mechanically, a test checks it; a rule is not enough.** Across 24
  releases of one project, only the fact a CI test guarded survived — but a test cannot check
  prose, so the rules above still need care.
- Create a document when first needed; do not pre-create empty files.

## 3. Order of work

1. **Read** `AGENTS.md`, `HANDOFF.md`, `docs/STATUS.md`, `docs/PLAN.md` and the top of
   `docs/JOURNAL.md`.
2. **Write down the intent before the code** — the action in `docs/PLAN.md` as
   `[ ]`/`[~]`, the reasoning in `docs/WORKLOG.md`. **Commit that separately, before
   touching code**: a docs-only commit is always green.
3. **Do the work.**
4. **Verify it**, proportionally to the risk of the change (§4).
5. **Record the result in the same change as the code:** `WORKLOG` (done / next), `PLAN`
   (`[x]`/`[!]`), `STATUS` (if state changed), `JOURNAL` (if learned), `HANDOFF` (if stopping).

The goal: the next agent can tell **what was planned, what shipped and what is next from the documents alone**, without reading the diff.

## 4. Verification and honest reporting

- **Never present the unverified as verified.** Could not run the tests — no SDK, no device,
  no access — say so plainly. Silence reads as "checked".
- **A green CI badge is not proof.** For build and deploy changes, read the actual logs and artifacts.
- **Simulation is not a claim about hardware or security.** Fakes exercise logic, not devices.
- **Close gaps with data, not reasoning.** Do not put a property into an algorithm that is not in the confirmed facts: guessed changes have already produced wrong results.
- **Do not invent domain content** — statute text, expert commentary, readings, constants.
- **Report the actual outcome.** Tests failed — show the output. A step was skipped — say so. Work is blocked — finish the rest and name what was left undone.

## 5. Actions an agent does not take alone

Most mistakes are undone by the next commit. These are not, so ask the owner first:

- **Losing data** — migrations that drop or rewrite data, destructive fixtures, clearing any
  store holding the only copy of something.
- **Removing published artifacts** — branches, tags, releases.
- **Rewriting history** — `force-push`, rebasing published commits, `filter-branch`. The
  trunk's history is append-only.
- **Changing a public contract** — API shape, wire and stored-data formats, identifiers other
  systems depend on.
- **Revoking or replacing keys and credentials** (§7).
- **Anything inside someone else's system** — another project's server, a shared host, a
  third-party account.

Say what would be lost, what the alternative is, and what you recommend. Once he agrees, do it
and record his decision in `JOURNAL`, so the next agent sees it was sanctioned, not improvised.

## 6. Deployment

Who deploys depends on **whether deployment needs manual work on the server**: a project that
**deploys itself through CI** may be deployed by **any agent**; one that **needs manual work on
the server** is deployed by **Watson only**, and other agents do not touch production.

- **If a push to the trunk means a production deploy, the project's rules say so.** There is no
  staging, which makes the green-trunk rule critical: a red commit is a broken production.
- **Do not create deploy keys, server credentials or release jobs** without the owner's decision.
  A change in the repository is never permission to deploy it.
- **No destructive operations on shared resources.** Where a webroot, database or host is shared
  with other projects, use only the deployment script provided — no `rsync --delete` over a whole
  directory. Unfamiliar directories are someone else's.
- **After deploying, verify what is live** — your project and its neighbours.

Production broken: **tell the owner immediately**, before investigating; **fix forward with a new
commit** (a revert is ordinary; the bad one stays in history, §5); then record in `JOURNAL` why.

## 7. Secrets

- **Never commit** credentials, tokens, private keys, personal data or production config.
- **Keep vendor binaries out of git** — fetch them with build scripts, pinned by SHA-256.
- **Found a secret? Report it. Do not remove it yourself, and never without the owner's
  knowledge.** It may be a deliberate exception; deleting it from the tree leaves it in git history
  while suggesting the leak is closed; revoking the key is his action. Name the file and commit.
- **A deliberate exception must be explicit.** Something secret-looking committed on purpose is
  recorded under "Settled decisions" with its reason — without it, every later agent re-raises it.

## 8. Settled decisions

Every project's rules carry a **"Settled decisions"** section: things decided deliberately that look like mistakes to a fresh pair of eyes.

- **Each decision is recorded with its reason.** The reason is mandatory — without it the next
  agent clears the decision away as junk.
- **An agent never reopens these on its own initiative.** Only the owner reverses them.
- Closed topics belong here too. Do not raise them again unasked.
- Durable architectural decisions become ADRs under `docs/decisions/` where a project needs it.

## 9. Scope and style of changes

- **Prefer clear, boring, maintainable solutions over speculative abstractions.**
- **Add dependencies, frameworks and infrastructure only as the adopted spec and the current stage
  require.** Anything beyond the adopted stack, cloud services included, needs a settled decision.
- **Add or update tests alongside the code they cover.**
- **Preserve unrelated work.** Unrelated cleanup goes into `PLAN.md` as its own item.
- **UTF-8, LF line endings.**

## 10. Language

- **Reply to the owner in Russian.**
- **Project documentation in Russian.**
- **Code identifiers and commit messages in English.**
- **Agent instruction files — this one, `CLAUDE.md`, `copilot-instructions.md` — in English.**
  They are instructions executed by a model, not documentation for a reader.
- **UI strings follow the project's convention.** Where tests assert on them, change both.

## 11. Working alongside other agents

Several agents may work in a repository at once, and any session can be interrupted, so **keep
changes narrow and independently reviewable** and **keep every task resumable** — the state of
unfinished work belongs in `HANDOFF.md` (§2). Roles may be split; the project's rules say so.

## 12. Environment

- **The environment is ephemeral.** Redo the GitHub access setup each session if it does not persist.
- **The proxy returns HTTP 403 on some writes** — pushing a tag, deleting a branch, writing through
  the REST API. Policy, not a failure: **do not work around it, report it.** Where it is genuinely
  needed, a workflow performs it.

## 13. Owner review

Where the owner checks by hand — installing a build on his phone, opening the site — **pause
after each completed stage** before starting the next. What he checks is in the project's rules.

## Appendix — what to add per project

This file is copied unchanged; project-specific material goes below it or in `CLAUDE.md`:

- **Commands** — build, tests, linter, formatter, and how to run a **single** test.
- **Map of the code** — architecture, entry points, non-obvious couplings.
- **Settled decisions**, with reasons (§8).
- **Departures from this file**, with reasons (§0).
- **Version discipline** — where the version lives and what changes with it.
- **Deployment** — CI or manual, who may do it, what to verify after (§6).
- **What the owner reviews**, and where a pause is expected (§13).
