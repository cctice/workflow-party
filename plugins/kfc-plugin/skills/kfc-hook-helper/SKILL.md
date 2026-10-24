---
name: kfc-hook-helper
description: KFC hook helper. Use this skill when KFC needs to check, install, or remove Codex and Claude Code prompt-submit hooks or Kiro global steering that reminds agents to enter KFC for development work.
---

# kfc-hook-helper

This skill owns KFC local rule checking, installation, removal, and closeout reminder helpers.

It is not a user short command. The `kfc` entry or `kfc-flow-router` should call:

```bash
node <kfc-hook-helper>/scripts/kfc-hook-helper.js check --root <workflow-root>
node <kfc-hook-helper>/scripts/kfc-hook-helper.js install --root <workflow-root> --agent codex
node <kfc-hook-helper>/scripts/kfc-hook-helper.js install --root <workflow-root> --agent claude-code
node <kfc-hook-helper>/scripts/kfc-hook-helper.js install --root <workflow-root> --agent kiro
node <kfc-hook-helper>/scripts/kfc-hook-helper.js remove --root <workflow-root> --agent codex
node <kfc-hook-helper>/scripts/kfc-hook-helper.js remove --root <workflow-root> --agent claude-code
node <kfc-hook-helper>/scripts/kfc-hook-helper.js remove --root <workflow-root> --agent kiro
```

## Rules

- Check is read-only.
- Installation may write user hook files or Kiro global steering, so AI must tell the user what will be changed before running install.
- Removal may write or delete user hook files or Kiro global steering, but must only remove entries or files containing the KFC marker.
- Skip agents whose home directory does not exist.
- Codex hooks are written to `~/.codex/hooks.json` under `hooks.UserPromptSubmit`, `hooks.PreToolUse`, `hooks.PostToolUse`, and `hooks.Stop`.
- Claude Code hooks are written to `~/.claude/settings.json` under `hooks.UserPromptSubmit`, `hooks.PreToolUse`, `hooks.PostToolUse`, and `hooks.Stop`.
- Kiro uses global steering, written to `~/.kiro/steering/kfc-routing.md`.
- Hook payloads switch the agent into KFC mode for concrete project work, including development, testing, deployment, documentation, configuration, bugfix, review, acceptance, workflow state, or deliverable work. KFC mode means the next action must be determined by KFC JSON, not by a passive preflight reminder.
- KFC mode must enter through the installed `kfc` skill entrypoint, equivalent to `/kfc <original user request>`. Agents must not replace `/kfc` with shell commands, MCP routers, project-local commands, global PATH commands, or direct route tools. `route --material` is internal to the `kfc` skill after entry.
- `UserPromptSubmit` tells the agent to classify the request, skip KFC for ordinary non-project conversation, and for project work choose one mode after reading KFC output: route-only, execution with active session, execution needing continue, or blocked.
- `PreToolUse` blocks AI-run `git commit` by default so formal project commits stay with the user after KFC closeout. If a project agent rule file such as `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, or `.codex/AGENTS.md` explicitly allows AI auto commits, the hook allows the commit after KFC closeout is complete.
- `PostToolUse` marks the active KFC workflow as having code changes when an edit-like tool or write-like shell command writes project content. Writes confined to `.kfc/` are state or artifact writes and do not mark code changes; mixed writes still do.
- 用户明确说某质量步骤不适用、已经人工验证通过或要求关闭当前 workflow 时，先由 KFC 记录 `record-user-decision` 和用户理由，再按返回的状态放行；不得把口头指令当成无记录豁免。
- If KFC reports `active_step_session.status=in_progress`, hook or steering guidance must keep the agent in the same selected skill session until that skill decides a recordable output is ready.
- `Stop` checks pending KFC active step sessions and quality gates before the final response. If an active step session is still in progress, it asks the agent to continue that skill session. If code changed and quality gates are still pending, it asks the agent to continue KFC closeout before replying to the user.
- Generic requests such as spreadsheet checks, form checks, casual questions, writing tasks, or non-project review requests should not enter KFC.
- Codex hooks still need to be reviewed and trusted in `/hooks` after installation or update. When using the app, restart the app and open a new conversation if the authorization entry is not visible; the entry usually appears above the prompt box.
- KFC closeout hooks must not create git commits. They only record state, run or request quality skills, and hand off to the user. On the first AI commit block, explain that formal or team projects should normally keep AI commits disabled; for learning, practice, or personal projects, the user can opt in with `允许 AI 自动提交：是（仅限本练习/个人项目）` or `KFC_ALLOW_AI_GIT_COMMIT=true` in an agent rule file.
