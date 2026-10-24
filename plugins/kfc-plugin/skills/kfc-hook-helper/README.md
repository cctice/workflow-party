# kfc-hook-helper

`kfc-hook-helper` checks, installs, and removes KFC local routing and closeout rules for supported local agents.

Supported agents:

- Codex: user hook file `~/.codex/hooks.json` with event lists under `hooks.UserPromptSubmit`, `hooks.PreToolUse`, `hooks.PostToolUse`, and `hooks.Stop`.
- Claude Code: user settings file `~/.claude/settings.json` with `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` hooks.
- Kiro: global steering file `~/.kiro/steering/kfc-routing.md`.

The installed rule adds KFC guidance when the submitted prompt looks like development, bug triage, performance investigation, repository, code, test, debug, verification, issue, PR, or documentation work. Generic requests such as spreadsheet checks, form checks, casual questions, or non-project review requests should not enter KFC.

For Codex and Claude Code, the installed rule also marks code changes after edit-like tool use and checks pending KFC quality gates before the final response. Pure `.kfc/` state or artifact writes do not count as code changes, while mixed writes still do. It blocks AI-run `git commit` by default, but allows it when an explicit project agent rule file enables AI auto commits. Kiro receives the same behavior as global steering guidance.

When a user explicitly confirms manual verification, declares a quality gate not applicable, or asks to close a workflow, the rule tells the agent to record that instruction through KFC before following it. This keeps the user decision auditable without making KFC an obstacle.

If KFC returns `reason: "unstable_kfc_state"` or `next_required_action: "run_doctor_then_retry_original_command"`, the agent must stop normal workflow actions, run `kfc.js doctor --root <dir>`, run `doctor --fix` when safe repair is needed, and retry the original KFC command after doctor reports stable.

## Runtime Entry

The installed rule must treat `/kfc` as the KFC skill entrypoint. `/kfc` is not a shell command, MCP tool, project-local script, global PATH command, or direct route tool.

When the rule enters KFC mode, the agent should invoke the installed `kfc` skill with the original user request, equivalent to `/kfc <original user request>`. `route --material` is an internal action performed by the KFC skill after the skill is entered. Agents must not replace `/kfc` with MCP router calls or project command lookup.

## Commands

```bash
node scripts/kfc-hook-helper.js check --root <workflow-root>
node scripts/kfc-hook-helper.js install --root <workflow-root> --agent codex
node scripts/kfc-hook-helper.js install --root <workflow-root> --agent claude-code
node scripts/kfc-hook-helper.js install --root <workflow-root> --agent kiro
node scripts/kfc-hook-helper.js remove --root <workflow-root> --agent codex
node scripts/kfc-hook-helper.js remove --root <workflow-root> --agent claude-code
node scripts/kfc-hook-helper.js remove --root <workflow-root> --agent kiro
node scripts/kfc-hook-helper.js emit --agent codex --event UserPromptSubmit
node scripts/kfc-hook-helper.js emit --agent codex --event PreToolUse
node scripts/kfc-hook-helper.js emit --agent codex --event PostToolUse
node scripts/kfc-hook-helper.js emit --agent codex --event Stop
node scripts/kfc-hook-helper.js emit --agent claude-code --event UserPromptSubmit
```

`check` is read-only. `install` writes hook configuration or Kiro global steering and creates a timestamped backup when it modifies an existing file. `remove` only removes entries or files containing the KFC marker and creates a timestamped backup before modifying or deleting a file. Codex hooks still need to be reviewed and trusted in `/hooks` after installation or update. When using the app, restart the app and open a new conversation if the authorization entry is not visible; the entry usually appears above the prompt box.

## AI Commit Policy

KFC closeout hooks do not create commits. `PreToolUse` blocks AI-run `git commit` unless the current project explicitly opts in through an agent rule file such as `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, or `.codex/AGENTS.md`.

Recommended opt-in line for learning or personal projects:

```text
允许 AI 自动提交：是（仅限本练习/个人项目）
```

Machine-readable opt-in marker:

```text
KFC_ALLOW_AI_GIT_COMMIT=true
```

Formal or team projects should normally keep AI commits disabled. On the first block, the rule tells the user this tradeoff and shows the opt-in wording for practice or personal projects. Even when auto commit is allowed, pending KFC quality closeout still blocks the commit until the required outputs are recorded.
