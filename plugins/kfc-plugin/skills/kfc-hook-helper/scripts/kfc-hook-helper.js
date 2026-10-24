#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER = "kfc-hook-helper";
const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const PROMPT_TEXT = [
  "KFC MODE: KFC is the workflow controller for concrete project work, not a checklist or a badge to touch before working.",
  "First classify the request. If it is ordinary conversation or unrelated form/spreadsheet/writing review, do not enter KFC.",
  "If it is concrete project work involving development, test, deployment, documentation, configuration, bugfix, review, acceptance, workflow state, or a deliverable, switch into KFC mode before substantive work.",
  "To enter KFC, invoke the installed `kfc` skill entrypoint with the original user request, equivalent to `/kfc <original user request>`.",
  "Do not use shell commands, MCP routers, project-local commands, global PATH commands, or direct route tools as the KFC entrypoint.",
  "`route --material` is an internal action performed by the KFC skill after the skill is entered.",
  "After invoking the KFC skill, read the returned JSON before acting.",
  "Running KFC is not enough. Your next action must be determined by the KFC result, especially current_stage, stage_substep_context, active_step_session, next_required_action, next_step, selected_skill, flow_node_check, workflow_selection_required, and stage_update_applied.",
  "If KFC returns reason=unstable_kfc_state or next_required_action=run_doctor_then_retry_original_command, stop normal work, run KFC doctor, fix safe state issues when instructed, then retry the original KFC command. Do not route, continue, complete, closeout, or work around KFC state while unstable.",
  "If the user explicitly says a quality gate is not applicable, a manual verification passed, or the current workflow should be closed, do not treat that as a bypass or ignore it. Preserve the user's instruction and first record it through the KFC router's `record-user-decision` action; only follow the returned state after the decision is recorded.",
  "After reading the KFC result, choose exactly one internal mode: route_only for read-only project inspection; execution_with_active_session to continue the selected skill session; execution_needs_continue to align stage if needed then continue and use selected_skill; blocked when workflow selection, stage mismatch, missing material, or user confirmation must be resolved first.",
  "For route_only, answer from KFC context and inspected materials without modifying files, running tests, calling complete, or pretending the workflow advanced.",
  "For execution work that may modify files, generate artifacts, run tests, review code, prepare deployment, fix bugs, implement requirements, or advance a deliverable, do not stop after route/current. Align the stage when needed, run continue, use the selected skill, and complete with output path and purpose after the skill output is ready.",
  "If KFC returns active_step_session, continue that exact selected skill session; do not re-route, skip to another step, or mark the step complete until the active skill decides a recordable output is ready.",
  "No active_step_session does not mean permission to work outside KFC.",
].join(" ");
const AGENT_RULE_FILE_NAMES = [
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "claude.md",
  path.join(".claude", "CLAUDE.md"),
  path.join(".codex", "AGENTS.md"),
];
const AI_COMMIT_ALLOW_PATTERNS = [
  /KFC_ALLOW_AI_GIT_COMMIT\s*=\s*true/i,
  /允许\s*AI\s*自动提交\s*[:：]\s*(是|允许|true|yes|on)/i,
  /允许\s*AI\s*(执行|运行)\s*git\s+commit/i,
  /AI\s*(可以|可)\s*自动提交/i,
  /AI\s*(可以|可)\s*(执行|运行)\s*git\s+commit/i,
  /allow\s+AI\s+(auto\s+)?(git\s+)?commit/i,
  /AI\s+(may|can)\s+(run\s+)?git\s+commit/i,
];
const AI_COMMIT_DENY_PATTERNS = [
  /(禁止|不允许|不得)\s*AI\s*自动提交/i,
  /(禁止|不允许|不得)\s*AI\s*(执行|运行)\s*git\s+commit/i,
  /AI\s*(must\s+not|cannot|can\s+not|should\s+not)\s+(run\s+)?git\s+commit/i,
  /do\s+not\s+allow\s+AI\s+(auto\s+)?(git\s+)?commit/i,
];
const SESSION_TEXT = [
  "KFC MODE active step session: KFC is the workflow controller, and a selected skill session is still in progress.",
  "Continue the current session and the same selected skill. Do not treat KFC as a completed checklist.",
  "Do not advance to another KFC step, re-route, or treat the workflow as finished.",
  "Only after the selected skill decides the step output is ready should you record complete with output path and purpose.",
].join(" ");
const CLOSEOUT_TEXT = [
  "KFC MODE closeout: code changes were detected in this workflow.",
  "Before the final user-facing response, continue KFC quality closeout from the current workflow state.",
  "KFC is the workflow controller; do not treat this as a passive reminder.",
  "Run the pending quality gates in order: automated verification, runtime selftest, code review, security review, and review readiness packaging.",
  "After each selected skill produces output, record its output path and purpose in KFC.",
  "If the user explicitly confirms a gate manually, declares a gate not applicable, or asks to close the workflow, record that user instruction first with KFC `record-user-decision`; then follow the returned pending gates or closed-workflow result.",
  "Do not create a git commit automatically. Hand off to the user after quality closeout is complete.",
].join(" ");

const DEV_PROMPT_PATTERN = "(开发|代码|实现|修复|测试|验证|单测|用例|接口|接口文档|技术文档|需求|工单|问题单|缺陷|评审|仓库|变更|分支|提交|性能|卡顿|加载慢|打开慢|切换慢|页面切换|报错|异常|崩溃|复现|重现|日志|issue|bug|repo|repository|code|test|debug|fix|implement|review|docs?|performance|perf|slow|error|exception|crash|pull request|commit|branch|\\bpr\\b)";
const CONTEXTUAL_WORK_PATTERN = "(帮我看下|帮我看看|看下|看看|排查|定位|分析|检查|处理|优化|改一下|看一下)";
const DEV_CONTEXT_PATTERN = "(页面|功能|系统|服务|项目|仓库|代码|接口|性能|卡顿|加载|切换|报错|异常|崩溃|日志|bug|issue|测试|需求|工单|问题单|缺陷)";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (_) {
    return "";
  }
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonWithBackup(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  if (fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak-${timestamp()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  return backupPath;
}

function writeTextWithBackup(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  if (fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak-${timestamp()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, text);
  return backupPath;
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak-${timestamp()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function shellQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

function commandQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function scriptPath() {
  return path.resolve(__filename);
}

function routerScriptPath() {
  return path.resolve(__dirname, "..", "..", "kfc-flow-router", "scripts", "kfc.js");
}

function nodePath() {
  return process.execPath || "node";
}

function codexDir() {
  return path.join(os.homedir(), ".codex");
}

function claudeDir() {
  return path.join(os.homedir(), ".claude");
}

function kiroDir() {
  return path.join(os.homedir(), ".kiro");
}

function codexHookPath() {
  return path.join(codexDir(), "hooks.json");
}

function claudeSettingsPath() {
  return path.join(claudeDir(), "settings.json");
}

function kiroHookPath(workflowRoot) {
  return path.join(path.resolve(workflowRoot || process.cwd()), ".kiro", "hooks", "kfc-lock.json");
}

function kiroSteeringPath() {
  return path.join(kiroDir(), "steering", "kfc-plugin-routing.md");
}

function codexCommand(eventName) {
  return `${commandQuote(nodePath())} ${commandQuote(scriptPath())} emit --agent codex --event ${commandQuote(eventName)}`;
}

function claudeHook(eventName) {
  return {
    type: "command",
    command: `${commandQuote(nodePath())} ${commandQuote(scriptPath())} emit --agent claude-code --event ${commandQuote(eventName)}`,
    timeout: 5,
  };
}

function containsMarker(value) {
  return JSON.stringify(value || {}).includes(MARKER) || JSON.stringify(value || {}).includes("kfc-hook-helper.js");
}

function agentInstalled(agent) {
  if (agent === "codex") return fs.existsSync(codexDir());
  if (agent === "claude-code") return fs.existsSync(claudeDir());
  if (agent === "kiro") return fs.existsSync(kiroDir());
  return false;
}

function checkCodex() {
  const configPath = codexHookPath();
  const config = readJsonIfExists(configPath, null);
  const officialHooks = config && config.hooks;
  const legacyHooks = config && config.UserPromptSubmit;
  const eventStatus = Object.fromEntries(HOOK_EVENTS.map((eventName) => [
    eventName,
    Boolean(containsMarker(officialHooks && officialHooks[eventName])),
  ]));
  return {
    agent: "codex",
    installed: agentInstalled("codex"),
    hook_path: configPath,
    has_kfc_hook: HOOK_EVENTS.every((eventName) => eventStatus[eventName]),
    hook_events: eventStatus,
    hook_format: Object.values(eventStatus).some(Boolean) ? "codex_hooks_object" : containsMarker(legacyHooks) ? "legacy_top_level_event" : null,
    needs_migration: Boolean(!eventStatus.UserPromptSubmit && containsMarker(legacyHooks)),
    install_supported: true,
    install_scope: "user",
  };
}

function checkClaude() {
  const configPath = claudeSettingsPath();
  const settings = readJsonIfExists(configPath, null);
  const eventStatus = Object.fromEntries(HOOK_EVENTS.map((eventName) => [
    eventName,
    Boolean(settings && settings.hooks && containsMarker(settings.hooks[eventName])),
  ]));
  return {
    agent: "claude-code",
    installed: agentInstalled("claude-code"),
    hook_path: configPath,
    has_kfc_hook: HOOK_EVENTS.every((eventName) => eventStatus[eventName]),
    hook_events: eventStatus,
    install_supported: true,
    install_scope: "user",
  };
}

function checkKiro(workflowRoot) {
  const steeringPath = kiroSteeringPath();
  const steering = fs.existsSync(steeringPath) ? fs.readFileSync(steeringPath, "utf8") : "";
  return {
    agent: "kiro",
    installed: agentInstalled("kiro"),
    hook_path: steeringPath,
    steering_path: steeringPath,
    has_kfc_hook: Boolean(steering && containsMarker(steering)),
    install_supported: true,
    install_scope: "user",
    rule_type: "global_steering",
    legacy_project_hook_path: kiroHookPath(workflowRoot),
  };
}

function checkAll(args) {
  const workflowRoot = args.root || process.cwd();
  const agents = [checkCodex(), checkClaude(), checkKiro(workflowRoot)];
  return {
    ok: true,
    workflow_root: path.resolve(workflowRoot),
    marker: MARKER,
    agents,
    missing_hooks: agents.filter((item) => item.installed && !item.has_kfc_hook),
    skipped_agents: agents.filter((item) => !item.installed),
  };
}

function ensureHookList(container, eventName) {
  container.hooks = container.hooks || {};
  container.hooks[eventName] = Array.isArray(container.hooks[eventName])
    ? container.hooks[eventName]
    : [];
  return container.hooks[eventName];
}

function codexHookList(config, eventName) {
  config.hooks = config.hooks && typeof config.hooks === "object" ? config.hooks : {};
  config.hooks[eventName] = Array.isArray(config.hooks[eventName])
    ? config.hooks[eventName]
    : [];
  return config.hooks[eventName];
}

function codexHookEntry(eventName) {
  return {
    matcher: eventName === "PreToolUse" || eventName === "PostToolUse" ? "Bash|Shell|exec|exec_command|functions.exec_command|Edit|Write|MultiEdit|NotebookEdit|apply_patch" : "",
    hooks: [
      {
        type: "command",
        command: codexCommand(eventName),
      },
    ],
  };
}

function installCodex() {
  if (!agentInstalled("codex")) return { ok: false, agent: "codex", skipped: true, reason: "agent_not_installed" };
  const configPath = codexHookPath();
  const config = readJsonIfExists(configPath, {});
  let migrated = false;
  if (Array.isArray(config.UserPromptSubmit)) {
    const entries = codexHookList(config, "UserPromptSubmit");
    for (const entry of config.UserPromptSubmit) {
      if (!containsMarker(entries) && containsMarker(entry)) {
        entries.push(entry);
        migrated = true;
      }
    }
    if (containsMarker(config.UserPromptSubmit)) {
      delete config.UserPromptSubmit;
      migrated = true;
    }
  }
  const installed_events = [];
  for (const eventName of HOOK_EVENTS) {
    const entries = codexHookList(config, eventName);
    if (!containsMarker(entries)) {
      entries.push(codexHookEntry(eventName));
      installed_events.push(eventName);
    }
  }
  const backup_path = writeJsonWithBackup(configPath, config);
  return { ok: true, agent: "codex", hook_path: configPath, backup_path, migrated, installed_events };
}

function installClaude() {
  if (!agentInstalled("claude-code")) return { ok: false, agent: "claude-code", skipped: true, reason: "agent_not_installed" };
  const settingsPath = claudeSettingsPath();
  const settings = readJsonIfExists(settingsPath, {});
  const installed_events = [];
  for (const eventName of HOOK_EVENTS) {
    const entries = ensureHookList(settings, eventName);
    if (!containsMarker(entries)) {
      entries.push({
        matcher: eventName === "PreToolUse" || eventName === "PostToolUse" ? "Bash|Shell|exec|exec_command|functions.exec_command|Edit|Write|MultiEdit|NotebookEdit" : "",
        hooks: [claudeHook(eventName)],
      });
      installed_events.push(eventName);
    }
  }
  const backup_path = writeJsonWithBackup(settingsPath, settings);
  return { ok: true, agent: "claude-code", hook_path: settingsPath, backup_path, installed_events };
}

function installKiro(workflowRoot) {
  if (!agentInstalled("kiro")) return { ok: false, agent: "kiro", skipped: true, reason: "agent_not_installed" };
  const steeringPath = kiroSteeringPath();
  const steering = [
    `<!-- ${MARKER}: kiro-global-steering -->`,
    "# KFC Routing",
    "",
    "This is a KFC global steering file for Kiro.",
    "",
    "KFC MODE: KFC is the workflow controller for concrete project work, not a checklist or a badge to touch before working.",
    "",
    "Before handling a user request, first decide whether the request is concrete project work. If it is ordinary conversation or unrelated form/spreadsheet/writing review, do not enter KFC.",
    "",
    "Enter KFC mode when the request involves development, test, deployment, documentation, configuration, bugfix, review, acceptance, workflow state, or a deliverable.",
    "",
    "To enter KFC, invoke the installed kfc skill entrypoint with the original user request, equivalent to /kfc <original user request>.",
    "",
    "Do not use shell commands, MCP routers, project-local commands, global PATH commands, or direct route tools as the KFC entrypoint.",
    "",
    "route --material is an internal action performed by the KFC skill after the skill is entered. After invoking the KFC skill, read the returned JSON before acting.",
    "",
    "Running KFC is not enough. Your next action must be determined by KFC fields such as current_stage, stage_substep_context, active_step_session, next_required_action, next_step, selected_skill, flow_node_check, workflow_selection_required, and stage_update_applied.",
    "",
    "When the user explicitly says a quality gate is not applicable, a manual verification passed, or the current workflow should close, preserve the instruction and first record it with KFC record-user-decision. Do not treat it as an unrecorded bypass.",
    "",
    "Choose one internal mode after reading KFC: route_only for read-only project inspection; execution_with_active_session to continue the selected skill session; execution_needs_continue to align stage if needed then continue and use selected_skill; blocked when workflow selection, stage mismatch, missing material, or user confirmation must be resolved first.",
    "",
    "For route_only, answer from KFC context and inspected materials without modifying files, running tests, calling complete, or pretending the workflow advanced.",
    "",
    "For execution work that may modify files, generate artifacts, run tests, review code, prepare deployment, fix bugs, implement requirements, or advance a deliverable, do not stop after route/current. Align the stage when needed, run continue, use the selected skill, and complete with output path and purpose after the skill output is ready.",
    "",
    "If KFC returns active_step_session, continue that exact selected skill session. Do not re-route, advance to another step, or mark the step complete until the active skill decides a recordable output is ready.",
    "",
    "No active_step_session does not mean permission to work outside KFC.",
    "",
    "After making code changes, before the final response, check whether KFC has pending quality gates. If code was changed, continue KFC quality closeout first: automated verification, runtime selftest, code review, security review, and review readiness packaging. Do not create a git commit automatically.",
    "",
  ].join("\n");
  const backup_path = writeTextWithBackup(steeringPath, steering);
  return {
    ok: true,
    agent: "kiro",
    hook_path: steeringPath,
    steering_path: steeringPath,
    backup_path,
    rule_type: "global_steering",
    legacy_project_hook_path: kiroHookPath(workflowRoot),
  };
}

function install(args) {
  const workflowRoot = args.root || process.cwd();
  const agent = args.agent || args._[1];
  const installers = {
    codex: installCodex,
    "claude-code": installClaude,
    claude: installClaude,
    kiro: () => installKiro(workflowRoot),
  };
  if (!agent || agent === "all") {
    const results = [installCodex(), installClaude(), installKiro(workflowRoot)];
    return { ok: results.every((item) => item.ok || item.skipped), workflow_root: path.resolve(workflowRoot), results };
  }
  if (!installers[agent]) throw new Error(`unknown agent: ${agent}`);
  return { ok: true, workflow_root: path.resolve(workflowRoot), result: installers[agent]() };
}

function removeMarkedHookItems(items) {
  if (!Array.isArray(items)) {
    return { next: [], removed: false };
  }
  const next = items.filter((item) => !containsMarker(item));
  return {
    next,
    removed: next.length !== items.length,
  };
}

function removeCodex() {
  if (!agentInstalled("codex")) return { ok: true, agent: "codex", skipped: true, reason: "agent_not_installed" };
  const configPath = codexHookPath();
  if (!fs.existsSync(configPath)) return { ok: true, agent: "codex", hook_path: configPath, removed: false, reason: "hook_file_missing" };
  const config = readJsonIfExists(configPath, {});
  const officialResults = Object.fromEntries(HOOK_EVENTS.map((eventName) => [
    eventName,
    removeMarkedHookItems(config.hooks && config.hooks[eventName]),
  ]));
  const legacyResult = removeMarkedHookItems(config.UserPromptSubmit);
  const removedOfficial = Object.values(officialResults).some((result) => result.removed);
  if (!removedOfficial && !legacyResult.removed) {
    return { ok: true, agent: "codex", hook_path: configPath, removed: false, reason: "kfc_hook_missing" };
  }
  if (config.hooks) {
    for (const eventName of HOOK_EVENTS) {
      if (Array.isArray(config.hooks[eventName])) {
        config.hooks[eventName] = officialResults[eventName].next;
      }
    }
  }
  if (Array.isArray(config.UserPromptSubmit)) {
    config.UserPromptSubmit = legacyResult.next;
    if (config.UserPromptSubmit.length === 0) delete config.UserPromptSubmit;
  }
  const backup_path = writeJsonWithBackup(configPath, config);
  return { ok: true, agent: "codex", hook_path: configPath, removed: true, backup_path };
}

function removeClaude() {
  if (!agentInstalled("claude-code")) return { ok: true, agent: "claude-code", skipped: true, reason: "agent_not_installed" };
  const settingsPath = claudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return { ok: true, agent: "claude-code", hook_path: settingsPath, removed: false, reason: "hook_file_missing" };
  const settings = readJsonIfExists(settingsPath, {});
  const results = Object.fromEntries(HOOK_EVENTS.map((eventName) => [
    eventName,
    removeMarkedHookItems(settings.hooks && settings.hooks[eventName]),
  ]));
  if (!Object.values(results).some((result) => result.removed)) {
    return { ok: true, agent: "claude-code", hook_path: settingsPath, removed: false, reason: "kfc_hook_missing" };
  }
  settings.hooks = settings.hooks || {};
  for (const eventName of HOOK_EVENTS) {
    if (Array.isArray(settings.hooks[eventName])) {
      settings.hooks[eventName] = results[eventName].next;
    }
  }
  const backup_path = writeJsonWithBackup(settingsPath, settings);
  return { ok: true, agent: "claude-code", hook_path: settingsPath, removed: true, backup_path };
}

function removeKiro(workflowRoot) {
  if (!agentInstalled("kiro")) return { ok: true, agent: "kiro", skipped: true, reason: "agent_not_installed" };
  const steeringPath = kiroSteeringPath();
  if (!fs.existsSync(steeringPath)) {
    return {
      ok: true,
      agent: "kiro",
      hook_path: steeringPath,
      steering_path: steeringPath,
      removed: false,
      reason: "steering_file_missing",
      rule_type: "global_steering",
    };
  }
  const steering = fs.readFileSync(steeringPath, "utf8");
  if (!containsMarker(steering)) {
    return {
      ok: true,
      agent: "kiro",
      hook_path: steeringPath,
      steering_path: steeringPath,
      removed: false,
      reason: "kfc_steering_missing",
      rule_type: "global_steering",
    };
  }
  const backup_path = backupFile(steeringPath);
  fs.unlinkSync(steeringPath);
  return {
    ok: true,
    agent: "kiro",
    hook_path: steeringPath,
    steering_path: steeringPath,
    removed: true,
    backup_path,
    rule_type: "global_steering",
    legacy_project_hook_path: kiroHookPath(workflowRoot),
  };
}

function remove(args) {
  const workflowRoot = args.root || process.cwd();
  const agent = args.agent || args._[1];
  const removers = {
    codex: removeCodex,
    "claude-code": removeClaude,
    claude: removeClaude,
    kiro: () => removeKiro(workflowRoot),
  };
  if (!agent || agent === "all") {
    const results = [removeCodex(), removeClaude(), removeKiro(workflowRoot)];
    return { ok: results.every((item) => item.ok || item.skipped), workflow_root: path.resolve(workflowRoot), results };
  }
  if (!removers[agent]) throw new Error(`unknown agent: ${agent}`);
  return { ok: true, workflow_root: path.resolve(workflowRoot), result: removers[agent]() };
}

function findPrompt(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(findPrompt).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  for (const key of ["prompt", "user_prompt", "userPrompt", "message", "input", "text"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return Object.values(value).map(findPrompt).filter(Boolean).join("\n");
}

function isDevelopmentPrompt(prompt) {
  const text = String(prompt || "");
  if (new RegExp(DEV_PROMPT_PATTERN, "i").test(text)) return true;
  return new RegExp(CONTEXTUAL_WORK_PATTERN, "i").test(text)
    && new RegExp(DEV_CONTEXT_PATTERN, "i").test(text);
}

function eventNameFrom(args, parsed) {
  return args.event
    || (parsed && (parsed.hook_event_name || parsed.hookEventName || parsed.event_name || parsed.eventName))
    || "UserPromptSubmit";
}

function validPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return path.resolve(value.trim());
}

function cwdFrom(parsed) {
  const input = toolInputFrom(parsed);
  const inputObject = input && typeof input === "object" ? input : {};
  const candidates = [
    inputObject.workdir,
    inputObject.cwd,
    inputObject.workspace_root,
    inputObject.workspaceRoot,
    inputObject.root,
    parsed && parsed.cwd,
    parsed && parsed.workspace_root,
    parsed && parsed.workspaceRoot,
    parsed && parsed.root,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    const resolved = validPath(candidate);
    if (resolved) return resolved;
  }
  return path.resolve(process.cwd());
}

function findAgentRuleFiles(startDir) {
  const files = [];
  let current = path.resolve(startDir || process.cwd());
  const home = os.homedir();
  while (true) {
    for (const name of AGENT_RULE_FILE_NAMES) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        files.push(candidate);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (current === home) break;
    current = parent;
  }
  return Array.from(new Set(files));
}

function aiAutoCommitPolicy(startDir) {
  const files = findAgentRuleFiles(startDir);
  for (const filePath of files) {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      continue;
    }
    if (AI_COMMIT_DENY_PATTERNS.some((pattern) => pattern.test(text))) {
      return {
        allowed: false,
        reason: "explicit_deny",
        file: filePath,
        checked_files: files,
      };
    }
    if (AI_COMMIT_ALLOW_PATTERNS.some((pattern) => pattern.test(text))) {
      return {
        allowed: true,
        reason: "explicit_allow",
        file: filePath,
        checked_files: files,
      };
    }
  }
  return {
    allowed: false,
    reason: "missing_explicit_allow",
    checked_files: files,
  };
}

function toolNameFrom(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  return parsed.tool_name
    || parsed.toolName
    || parsed.tool
    || (parsed.tool_call && (parsed.tool_call.name || parsed.tool_call.tool_name))
    || "";
}

function toolInputFrom(parsed) {
  if (!parsed || typeof parsed !== "object") return {};
  return parsed.tool_input || parsed.toolInput || parsed.input || (parsed.tool_call && parsed.tool_call.input) || {};
}

function commandTextFromToolInput(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return JSON.stringify(input);
}

function addTouchedPath(paths, value, cwd) {
  if (typeof value !== "string" || !value.trim()) return;
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed === "/dev/null") return;
  paths.add(path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed));
}

function touchedPathsFromPatchText(text, cwd, paths) {
  if (typeof text !== "string") return;
  for (const line of text.split(/\r?\n/)) {
    let match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
    if (match) {
      addTouchedPath(paths, match[1], cwd);
      continue;
    }
    match = line.match(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+)$/);
    if (match) addTouchedPath(paths, match[1], cwd);
  }
}

function touchedPathsFromCommand(commandText, cwd, paths) {
  if (typeof commandText !== "string") return;
  const redirection = /(?:^|\s)(?:>|>>)\s*([^\s;&|]+)/g;
  const tee = /\btee(?:\s+-a)?\s+([^\s;&|]+)/g;
  for (const pattern of [redirection, tee]) {
    let match;
    while ((match = pattern.exec(commandText))) addTouchedPath(paths, match[1], cwd);
  }
}

function touchedPathsFromInput(input, cwd, paths) {
  if (!input) return;
  if (typeof input === "string") {
    touchedPathsFromPatchText(input, cwd, paths);
    return;
  }
  if (typeof input !== "object") return;
  for (const field of ["file_path", "filePath", "path", "notebook_path", "notebookPath"]) {
    addTouchedPath(paths, input[field], cwd);
  }
  for (const field of ["patch", "diff"]) {
    touchedPathsFromPatchText(input[field], cwd, paths);
  }
  for (const field of ["edits", "files", "changes"]) {
    if (!Array.isArray(input[field])) continue;
    for (const entry of input[field]) touchedPathsFromInput(entry, cwd, paths);
  }
}

function touchedPathsFromTool(parsed) {
  const cwd = cwdFrom(parsed);
  const input = toolInputFrom(parsed);
  const paths = new Set();
  touchedPathsFromInput(input, cwd, paths);
  const toolName = String(toolNameFrom(parsed));
  if (/^(Bash|Shell|exec|exec_command|functions\.exec_command)$/i.test(toolName)) {
    touchedPathsFromCommand(commandTextFromToolInput(input), cwd, paths);
  }
  return { cwd, paths: Array.from(paths) };
}

function isKfcStatePath(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative === ".kfc" || relative.startsWith(`.kfc${path.sep}`);
}

function isCodeChangingTool(parsed) {
  const toolName = String(toolNameFrom(parsed));
  const directWrite = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/i.test(toolName);
  const shellWrite = /^(Bash|Shell|exec|exec_command|functions\.exec_command)$/i.test(toolName);
  if (!directWrite && !shellWrite) return false;
  const commandText = commandTextFromToolInput(toolInputFrom(parsed));
  const writeLike = directWrite || /(apply_patch|git\s+apply|cat\s+>|>\s*[^&|]|>>\s*[^&|]|\btee\b|\bsed\s+-i\b|\bperl\s+-pi\b|writeFileSync|write_text|npm\s+run\s+\S*fix|eslint\b.*--fix|prettier\b.*--write)/i.test(commandText);
  if (!writeLike) return false;
  const touched = touchedPathsFromTool(parsed);
  if (!touched.paths.length) return true;
  return touched.paths.some((filePath) => !isKfcStatePath(filePath, touched.cwd));
}

function isGitCommitCommand(parsed) {
  const toolName = String(toolNameFrom(parsed));
  if (!/^(Bash|Shell|exec|exec_command|functions\.exec_command)$/i.test(toolName)) return false;
  return /\bgit\s+commit\b/i.test(commandTextFromToolInput(toolInputFrom(parsed)));
}

function runRouter(command, args) {
  const { execFileSync } = require("child_process");
  const stdout = execFileSync(nodePath(), [routerScriptPath(), command, ...args], {
    encoding: "utf8",
    timeout: Number(process.env.KFC_HOOK_ROUTER_TIMEOUT_MS || 10000),
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function markCodeChange(parsed, eventName) {
  if (!isCodeChangingTool(parsed)) return null;
  return runRouter("mark-code-change", [
    "--root", cwdFrom(parsed),
    "--event", eventName,
    "--tool-name", toolNameFrom(parsed) || "unknown",
    "--source", "hook",
  ]);
}

function closeoutCheck(parsed) {
  if (parsed && (parsed.stop_hook_active || parsed.stopHookActive)) return null;
  return runRouter("closeout-check", [
    "--root", cwdFrom(parsed),
    "--prepare",
  ]);
}

function stopBlockOutput(agent, check) {
  if (!check || !check.needs_closeout) return null;
  if (check.pending_reason === "active_step_session" && check.active_step_session) {
    const session = check.active_step_session;
    const skill = session.selected_skill || session.skill || session.selected_worker || "the active KFC skill";
    const reason = [
      `${MARKER}: ${SESSION_TEXT}`,
      `Workflow: ${check.workflow_id || "current"}.`,
      `Active KFC step session: ${session.stage}.${session.step_id} using ${skill}.`,
      "Continue this active step session now. If the skill needs more user input, ask for it; if it has produced a recordable output, run KFC complete with output path and purpose.",
    ].join(" ");
    return {
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: agent === "claude-code" || agent === "claude" ? "Stop" : "Stop",
        additionalContext: reason,
      },
    };
  }
  const nextStep = check.next_quality_gate_step || {};
  const reason = [
    `${MARKER}: ${CLOSEOUT_TEXT}`,
    `Workflow: ${check.workflow_id || "current"}.`,
    `Next KFC quality gate: ${nextStep.step_id || "pending"} using ${nextStep.default_worker || "the default KFC skill"}.`,
    "Continue now by reading the KFC closeout-check result, running the next selected skill, recording its output path and purpose, and repeating until pending_quality_gates is empty.",
  ].join(" ");
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: agent === "claude-code" || agent === "claude" ? "Stop" : "Stop",
      additionalContext: reason,
    },
  };
}

function gitCommitBlockOutput(agent, check) {
  const nextStep = check && check.next_quality_gate_step ? check.next_quality_gate_step : {};
  const pending = check && Array.isArray(check.pending_quality_gates) ? check.pending_quality_gates : [];
  const reasonParts = [
    `${MARKER}: KFC MODE commit guard: AI must not create git commits automatically.`,
  ];
  if (check && check.needs_closeout) {
    reasonParts.push(
      "Code changes are still waiting for KFC quality closeout.",
      `Next KFC quality gate: ${nextStep.step_id || pending[0] || "pending"} using ${nextStep.default_worker || "the default KFC skill"}.`,
      "Continue KFC closeout first, record each quality output path and purpose, then hand off commit instructions to the user."
    );
  } else {
    reasonParts.push("Hand off the prepared commit command or summary to the user instead of running git commit yourself.");
  }
  const reason = reasonParts.join(" ");
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: agent === "claude-code" || agent === "claude" ? "PreToolUse" : "PreToolUse",
      additionalContext: reason,
    },
  };
}

function gitCommitPolicyBlockOutput(agent, policy) {
  const checked = policy.checked_files && policy.checked_files.length
    ? policy.checked_files.join(", ")
    : "no AGENTS.md / CLAUDE.md style project rule file found";
  const reason = [
    `${MARKER}: KFC MODE commit guard: 当前项目没有开启 AI 自动提交。`,
    "如果是正式项目或团队项目，建议不要放行自动提交，由用户自己提交。",
    "如果是练习项目、学习项目或个人项目，可以在项目规则文件里明确允许 AI 自动提交。",
    "推荐写法：`允许 AI 自动提交：是（仅限本练习/个人项目）`。",
    "机器可读写法：`KFC_ALLOW_AI_GIT_COMMIT=true`。",
    `已检查的项目规则文件：${checked}.`,
  ].join(" ");
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: agent === "claude-code" || agent === "claude" ? "PreToolUse" : "PreToolUse",
      additionalContext: reason,
    },
  };
}

function emit(args) {
  const agent = args.agent || "codex";
  const input = readStdin();
  let parsed = null;
  try {
    parsed = input.trim() ? JSON.parse(input) : null;
  } catch (_) {
    parsed = null;
  }
  const eventName = eventNameFrom(args, parsed);
  if (eventName === "PreToolUse") {
    if (isGitCommitCommand(parsed)) {
      const check = closeoutCheck(parsed);
      if (check && check.needs_closeout) {
        return gitCommitBlockOutput(agent, check);
      }
      const policy = aiAutoCommitPolicy(cwdFrom(parsed));
      if (!policy.allowed) {
        return gitCommitPolicyBlockOutput(agent, policy);
      }
      return null;
    }
    return null;
  }
  if (eventName === "PostToolUse") {
    markCodeChange(parsed, eventName);
    return null;
  }
  if (eventName === "Stop") {
    return stopBlockOutput(agent, closeoutCheck(parsed));
  }
  const prompt = process.env.USER_PROMPT || findPrompt(parsed) || input;
  if (!isDevelopmentPrompt(prompt)) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `${MARKER}: ${PROMPT_TEXT}`,
    },
  };
}

function help() {
  return [
    "kfc-hook-helper",
    "",
    "Commands:",
    "  check --root <workflow-root>",
    "  install --root <workflow-root> --agent <codex|claude-code|kiro|all>",
    "  remove --root <workflow-root> --agent <codex|claude-code|kiro|all>",
    "  emit --agent <codex|claude-code> [--event <UserPromptSubmit|PostToolUse|Stop>]",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || args.help) {
      console.log(help());
      return;
    }
    if (command === "check") {
      console.log(JSON.stringify(checkAll(args), null, 2));
      return;
    }
    if (command === "install") {
      console.log(JSON.stringify(install(args), null, 2));
      return;
    }
    if (command === "remove") {
      console.log(JSON.stringify(remove(args), null, 2));
      return;
    }
    if (command === "emit") {
      const result = emit(args);
      if (result) console.log(JSON.stringify(result));
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  checkAll,
  install,
  remove,
  emit,
  PROMPT_TEXT,
  DEV_PROMPT_PATTERN,
};
