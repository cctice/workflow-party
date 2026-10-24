#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const {
  kfcStateRoot,
  activeWorkflowsPath,
  builtinSkillRegistryPath,
  userSkillRegistryPath,
  userStepRegistryPath,
  nowIso,
  createWorkflowState,
  readActiveWorkflows,
  writeActiveWorkflows,
  readWorkflowState,
  readProjectContext,
  readSkillRegistry,
  readUserStepRegistry,
  writeStepRegistry,
  upsertProjectContextEntry,
  removeProjectContextEntry,
  upsertSkillRegistryEntry,
  removeSkillRegistryEntry,
  upsertStepRegistryEntry,
  removeStepRegistryEntry,
  upsertDefaultSkill,
  removeDefaultSkill,
  writeWorkflowState,
  upsertActiveWorkflow,
  resolveWorkflow,
} = require("./state");
const {
  readSystemStageSteps,
  readStageSteps,
  readEffectiveStageSteps,
  stepRegistrySchema,
  validateStepRegistry,
  readWorkerCatalog,
  stageCatalog,
} = require("./catalog");

const referenceRoot = __dirname;
const routerRoot = path.dirname(referenceRoot);
const skillsRoot = path.dirname(routerRoot);
const hookHelperScript = path.join(skillsRoot, "kfc-hook-helper", "scripts", "kfc-hook-helper.js");
const qualityGateStage = "test-and-selftest";
const qualityGateStepIds = readSystemStageSteps().stages[qualityGateStage].default_steps.map((step) => step.step_id);

function updateCommands() {
  return ["在插件市场中更新 kfc-plugin，然后重启当前 Agent 会话。"];
}

function commandUpdate() {
  return { ok: true, automatic_update: false, instructions: updateCommands(), message: "通过插件市场更新个人插件；保留用户配置。" };
}

function dependencyInstallCommand() {
  return "缺少外部 skill 时，请显式安装该 skill，或通过注册表选择已有 worker。";
}

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

function workflowRootInfo(workflowRoot) {
  const root = path.resolve(workflowRoot || process.cwd());
  return {
    workflow_root: root,
    state_root: kfcStateRoot(root),
    registry_path: userSkillRegistryPath(),
    step_registry_path: userStepRegistryPath(),
    builtin_registry_path: builtinSkillRegistryPath(),
  };
}

function readJsonSafe(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function requiredWorkflowFieldsMissing(state) {
  const missing = [];
  for (const field of ["version", "workflow_id", "status", "current_stage", "current_step_index"]) {
    if (state[field] === undefined || state[field] === null || state[field] === "") {
      missing.push(field);
    }
  }
  if (!Array.isArray(state.stage_history)) missing.push("stage_history");
  if (!Array.isArray(state.outputs)) missing.push("outputs");
  return missing;
}

function workflowDirs(workflowRoot) {
  const dir = path.join(kfcStateRoot(workflowRoot), "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function stateStability(workflowRoot) {
  const root = path.resolve(workflowRoot || process.cwd());
  const stateRoot = kfcStateRoot(root);
  const activePath = activeWorkflowsPath(root);
  const issues = [];
  const healthyWorkflows = [];
  const workflowById = new Map();
  let active = { version: 1, default_workflow_id: null, workflows: [] };

  if (fs.existsSync(activePath)) {
    const parsed = readJsonSafe(activePath);
    if (!parsed.ok) {
      issues.push({
        code: "active_workflows_json_invalid",
        severity: "blocking",
        path: activePath,
        message: "active-workflows.json is not valid JSON",
        error: parsed.error,
      });
    } else {
      active = parsed.value || active;
      active.workflows = Array.isArray(active.workflows) ? active.workflows : [];
    }
  }

  const activeIds = new Set((active.workflows || []).map((item) => item && item.workflow_id).filter(Boolean));
  if (active.default_workflow_id) activeIds.add(active.default_workflow_id);

  for (const workflowId of workflowDirs(root)) {
    const workflowDir = path.join(stateRoot, "workflows", workflowId);
    const statePath = path.join(workflowDir, "workflow-state.json");
    const tmpPath = `${statePath}.tmp`;
    const hasState = fs.existsSync(statePath);
    const hasTmp = fs.existsSync(tmpPath);
    if (hasTmp) {
      issues.push({
        code: "workflow_state_tmp_exists",
        severity: hasState ? "warning" : "blocking",
        workflow_id: workflowId,
        path: tmpPath,
        message: hasState
          ? "workflow-state.json.tmp remains after a completed state file exists"
          : "workflow-state.json.tmp exists without a completed workflow-state.json",
      });
    }
    if (!hasState) {
      const children = fs.readdirSync(workflowDir);
      issues.push({
        code: children.length ? "workflow_state_missing" : "empty_workflow_dir",
        severity: activeIds.has(workflowId) ? "blocking" : "warning",
        workflow_id: workflowId,
        path: statePath,
        message: "workflow directory does not contain workflow-state.json",
      });
      continue;
    }
    const parsed = readJsonSafe(statePath);
    if (!parsed.ok) {
      issues.push({
        code: "workflow_state_json_invalid",
        severity: "blocking",
        workflow_id: workflowId,
        path: statePath,
        message: "workflow-state.json is not valid JSON",
        error: parsed.error,
      });
      continue;
    }
    const state = parsed.value || {};
    const missing = requiredWorkflowFieldsMissing(state);
    if (missing.length) {
      issues.push({
        code: "workflow_state_required_fields_missing",
        severity: "blocking",
        workflow_id: workflowId,
        path: statePath,
        message: "workflow-state.json is missing required fields",
        missing_fields: missing,
      });
      continue;
    }
    if (state.workflow_id !== workflowId) {
      issues.push({
        code: "workflow_id_mismatch",
        severity: "blocking",
        workflow_id: workflowId,
        path: statePath,
        message: "workflow directory name and workflow-state.json workflow_id differ",
        state_workflow_id: state.workflow_id,
      });
      continue;
    }
    healthyWorkflows.push(workflowSummaryForDoctor(state));
    workflowById.set(workflowId, state);
  }

  for (const item of active.workflows || []) {
    if (!item || !item.workflow_id) {
      issues.push({
        code: "active_workflow_entry_invalid",
        severity: "blocking",
        message: "active-workflows contains an entry without workflow_id",
      });
      continue;
    }
    if (!workflowById.has(item.workflow_id)) {
      issues.push({
        code: "active_points_to_missing_or_broken_workflow",
        severity: "blocking",
        workflow_id: item.workflow_id,
        path: path.join(stateRoot, "workflows", item.workflow_id, "workflow-state.json"),
        message: "active-workflows points to a missing or broken workflow-state.json",
      });
    }
  }
  if (active.default_workflow_id && !workflowById.has(active.default_workflow_id)) {
    issues.push({
      code: "default_workflow_missing_or_broken",
      severity: "blocking",
      workflow_id: active.default_workflow_id,
      message: "default_workflow_id points to a missing or broken workflow",
    });
  }

  const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
  return {
    stable: blockingIssues.length === 0 && issues.length === 0,
    has_blocking_issues: blockingIssues.length > 0,
    workflow_root: root,
    state_root: stateRoot,
    active_workflows_path: activePath,
    issues,
    healthy_workflows: healthyWorkflows,
    default_workflow_id: active.default_workflow_id || null,
    active_workflows: active.workflows || [],
  };
}

function workflowSummaryForDoctor(state) {
  const session = activeStepSession(state);
  return {
    workflow_id: state.workflow_id,
    title: state.title,
    status: state.status,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    updated_at: state.updated_at,
    active_step_session: session ? {
      session_id: session.session_id,
      stage: session.stage,
      step_id: session.step_id,
      selected_skill: session.selected_skill || session.skill || session.selected_worker,
      status: session.status,
    } : null,
    pending_closeout: Boolean(state.quality_gate_tracking && state.quality_gate_tracking.dev_work_changed),
  };
}

function unstableStateResponse(command, args, stability) {
  const workflowRoot = args.root || process.cwd();
  return {
    ok: false,
    message: "KFC state is not stable; run doctor before continuing",
    reason: "unstable_kfc_state",
    ...workflowRootInfo(workflowRoot),
    state_stability: stability,
    blocked_until_stable: true,
    next_required_action: "run_doctor_then_retry_original_command",
    retry_command: retryCommand(command, args),
    ai_required_actions: [
      "run `kfc.js doctor --root <dir>` before continuing",
      "if doctor reports fixable issues, run `kfc.js doctor --root <dir> --fix`",
      "retry the original KFC command only after doctor reports stable",
      "do not route, continue, complete, closeout, or work around KFC state while unstable",
    ],
  };
}

function retryCommand(command, args) {
  const parts = [command];
  for (const [key, value] of Object.entries(args)) {
    if (key === "_") continue;
    if (value === true) {
      parts.push(`--${key}`);
    } else if (value !== false && value !== undefined && value !== null) {
      parts.push(`--${key}`, String(value));
    }
  }
  return parts;
}


function rootDiagnostics(workflowRoot) {
  const info = workflowRootInfo(workflowRoot);
  const active = readActiveWorkflows(info.workflow_root);
  const registry = readSkillRegistry();
  const stepRegistry = readUserStepRegistry();
  const stepValidation = validateStepRegistry(stepRegistry);
  return {
    ...info,
    has_current_state_root: fs.existsSync(info.state_root),
    workflow_count: active.workflows.length,
    default_workflow_id: active.default_workflow_id,
    registry_skill_count: registry.entries.length,
    default_skill_count: registry.default_skills.length,
    registry_scope: "global",
    builtin_registry_path: builtinSkillRegistryPath(),
    user_registry_path: userSkillRegistryPath(),
    user_step_registry_path: userStepRegistryPath(),
    user_step_registry_count: stepRegistry.steps.length,
    user_step_registry_valid: stepValidation.ok,
    user_step_registry_errors: stepValidation.errors,
    builtin_registry_skill_count: registry.entries.filter((entry) => entry.registry_source === "builtin").length,
    user_registry_skill_count: registry.entries.filter((entry) => entry.registry_source === "user").length,
    registry_skills: registry.entries.map((entry) => ({
      skill: entry.skill,
      stage: entry.stage,
      step_id: entry.step_id,
      registry_source: entry.registry_source || "user",
      patterns: entry.patterns || [],
    })),
    default_skills: registry.default_skills.map((entry) => ({
      skill: entry.skill,
      stage: entry.stage,
      step_id: entry.step_id,
      registry_source: entry.registry_source || "user",
      reason: entry.reason || "",
    })),
  };
}

function output(data, args) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    data = attachUserOutputSlots(data);
  }
  if (args.text) {
    console.log(textSummary(data));
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function textSummary(data) {
  if (Array.isArray(data)) return data.join("\n");
  if (!data || typeof data !== "object") return String(data);
  const lines = [];
  if (data.message) lines.push(data.message);
  if (data.workflow_id) lines.push(`workflow_id: ${data.workflow_id}`);
  if (data.current_stage) lines.push(`current_stage: ${data.current_stage}`);
  if (data.next_stage) lines.push(`next_stage: ${data.next_stage}`);
  if (data.stage_substep_context && data.stage_substep_context.current_stage_substep) {
    lines.push(`current_stage_substep: ${data.stage_substep_context.current_stage_substep}`);
  }
  if (data.stage_substep_context && data.stage_substep_context.next_stage_substep) {
    lines.push(`next_stage_substep: ${data.stage_substep_context.next_stage_substep}`);
  }
  if (data.selected_skill || data.selected_worker) lines.push(`selected_skill: ${data.selected_skill || data.selected_worker}`);
  if (data.output_path) lines.push(`output_path: ${data.output_path}`);
  if (data.available_skills) {
    lines.push("available_skills:");
    for (const item of data.available_skills) {
      lines.push(`- ${item.name}: ${item.summary || ""}`.trim());
    }
  }
  return lines.length ? lines.join("\n") : JSON.stringify(data, null, 2);
}

function stageKeywordRules() {
  return [
    ["acceptance-feedback", ["验收反馈", "反馈处理", "复审", "acceptance feedback"]],
    ["acceptance-guide", ["验收指南", "验收用例", "人工验收", "acceptance guide"]],
    ["test-and-selftest", ["测试", "自测", "验证", "test", "selftest", "review", "代码审查"]],
    ["development-execution", ["开发", "实现", "编码", "代码", "diff", "pull request"]],
    ["task-breakdown", ["任务拆分", "任务包", "task breakdown", "task"]],
    ["detailed-design", ["详细设计", "实现设计", "detailed design"]],
    ["solution-outline", ["概要设计", "技术方案", "方案设计", "solution"]],
    ["requirement", ["需求", "prd", "讨论稿", "需求文档", "requirement"]],
  ];
}

function inferStage(material) {
  const value = String(material || "").toLowerCase();
  for (const [stage, keywords] of stageKeywordRules()) {
    if (keywords.some((keyword) => value.includes(keyword))) return stage;
  }
  return "requirement";
}

function stageIdsInOrder() {
  return Object.keys(readStageSteps().stages || {});
}

function stageIndex(stageId) {
  const index = stageIdsInOrder().indexOf(stageId);
  return index >= 0 ? index : 0;
}

function stageReadinessRules(stageId) {
  const match = stageKeywordRules().find(([stage]) => stage === stageId);
  return match ? match[1] : [];
}

function materialHasEvidenceForStage(material, stageId) {
  if (stageId === "requirement") return true;
  const value = normalizeText(material);
  return stageReadinessRules(stageId).some((keyword) => value.includes(normalizeText(keyword)));
}

function resolveEvidenceBackedStage(candidateStage, material) {
  const stages = stageIdsInOrder();
  let index = stageIndex(candidateStage);
  const checked = [];
  while (index >= 0) {
    const stageId = stages[index] || "requirement";
    const evidenceFound = materialHasEvidenceForStage(material, stageId);
    checked.push({
      stage: stageId,
      evidence_found: evidenceFound,
    });
    if (evidenceFound) {
      return {
        stage: stageId,
        initial_candidate_stage: candidateStage,
        checked_stages: checked,
        fallback_applied: stageId !== candidateStage,
      };
    }
    index -= 1;
  }
  return {
    stage: "requirement",
    initial_candidate_stage: candidateStage,
    checked_stages: checked,
    fallback_applied: candidateStage !== "requirement",
  };
}

function resolveFlowFocus({ workflowRoot, state, material, materialInspection, explicitStage }) {
  const inspectedMaterial = materialInspection || inspectMaterial(material, workflowRoot);
  const materialForStage = inspectedMaterial.content_for_stage || material || "";
  const candidateStage = explicitStage || inferStage(materialForStage);
  const stageEvidence = explicitStage
    ? {
      stage: explicitStage,
      initial_candidate_stage: explicitStage,
      checked_stages: [{ stage: explicitStage, evidence_found: true, source: "explicit_stage" }],
      fallback_applied: false,
    }
    : resolveEvidenceBackedStage(candidateStage, materialForStage);
  const stage = stageEvidence.stage;
  return {
    stage,
    inferred_stage: candidateStage,
    stage_evidence: stageEvidence,
    material_inspection: inspectedMaterial,
    flow_node_check: flowNodeCheck(workflowRoot, state, material, stage, inspectedMaterial),
  };
}

function inspectMaterial(material, workflowRoot) {
  const value = String(material || "").trim();
  if (!value) {
    return {
      kind: "empty",
      route_runner_can_read: false,
      ai_must_check_content: true,
      ai_action: "ask_user_or_use_current_context",
    };
  }

  if (/^https?:\/\//i.test(value)) {
    return {
      kind: "url",
      value,
      route_runner_can_read: false,
      ai_must_check_content: true,
      ai_action: "read_url_content_then_route_with_stage",
      note: "URL is material. The AI must read the linked content before final stage judgment.",
    };
  }

  const candidates = [
    path.resolve(workflowRoot || process.cwd(), value),
    path.resolve(value),
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (filePath) {
    const stat = fs.statSync(filePath);
    const result = {
      kind: stat.isDirectory() ? "directory" : "file",
      value,
      resolved_path: filePath,
      route_runner_can_read: stat.isFile(),
      ai_must_check_content: true,
      ai_action: stat.isFile() ? "read_file_content_and_confirm_stage" : "inspect_directory_and_confirm_stage",
    };
    if (stat.isFile()) {
      result.preview = fs.readFileSync(filePath, "utf8").slice(0, 4000);
      result.content_for_stage = result.preview;
    }
    return result;
  }

  return {
    kind: "text",
    value,
    route_runner_can_read: true,
    ai_must_check_content: true,
    ai_action: "scan_text_content_and_confirm_stage",
    content_for_stage: value,
  };
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function looksLikeDevelopmentMaterial(value) {
  const text = normalizeText(value);
  return [
    "开发",
    "实现",
    "编码",
    "代码",
    "bug",
    "修复",
    "diff",
    "pull request",
    "pr",
    "test",
    "review",
  ].some((keyword) => text.includes(keyword));
}

function workflowSearchText(workflowRoot, summary) {
  const state = readWorkflowState(workflowRoot, summary.workflow_id) || {};
  return normalizeText([
    summary.workflow_id,
    summary.title,
    summary.current_stage,
    ...(state.materials || []).map((item) => item.material),
    ...(state.outputs || []).map((item) => [item.output_path, item.output_purpose, item.produced_by].join(" ")),
  ].join(" "));
}

function workflowCandidates(workflowRoot, material, inferredStage) {
  const active = readActiveWorkflows(workflowRoot);
  const materialText = normalizeText(material);
  const words = materialText.split(/[\s/\\:_?&=#.-]+/).filter((item) => item.length >= 2);
  return active.workflows
    .filter((summary) => summary && summary.status !== "completed")
    .map((summary) => {
      const searchText = workflowSearchText(workflowRoot, summary);
      const titleText = normalizeText(summary.title);
      let score = 0;
      if (summary.current_stage === inferredStage) score += 1;
      if (materialText && searchText.includes(materialText)) score += 5;
      if (materialText && titleText && materialText.includes(titleText)) score += 4;
      if (materialText && summary.workflow_id && materialText.includes(normalizeText(summary.workflow_id))) score += 4;
      for (const word of words) {
        if (searchText.includes(word)) score += 1;
      }
      return { ...summary, match_score: score };
    })
    .filter((item) => item.match_score > 0)
    .sort((left, right) => right.match_score - left.match_score);
}

function attachUserOutputSlots(data) {
  const substepContext = data.stage_substep_context || stageSubstepContextFromData(data);
  const activeSession = data.active_step_session || (data.workflow && data.workflow.active_step_session) || null;
  const slots = {
    current_conclusion: data.message || (data.ok === false ? "需要用户选择或补充信息" : "已完成当前 KFC 路由动作"),
    workflow_root: data.workflow_root || (data.root_diagnostics && data.root_diagnostics.workflow_root) || "暂无",
    registry_path: data.registry_path || (data.root_diagnostics && data.root_diagnostics.registry_path) || "暂无",
    registry_scope: data.root_diagnostics && data.root_diagnostics.registry_scope || "global",
    current_workflow: data.workflow_id || data.default_workflow_id || "暂无",
    current_stage: substepContext.current_stage || data.current_stage || data.stage || "暂无",
    current_stage_substep: substepContext.current_stage_substep || "暂无",
    next_stage: substepContext.next_stage || "暂无",
    next_stage_substep: substepContext.next_stage_substep || "暂无",
    available_skills: Array.isArray(data.available_skills) ? data.available_skills.map((item) => item.name) : [],
    suggested_skill: data.selected_skill || data.selected_worker || substepContext.current_stage_substep_default_worker || "暂无",
    project_context_entries: Array.isArray(data.project_context_entries)
      ? data.project_context_entries.map((item) => `${item.id}: ${item.title || item.ref}`)
      : [],
    flow_node_check: data.flow_node_check ? data.flow_node_check.recommended_action : "暂无",
    suggested_output_dir: data.suggested_output_dir || "暂无",
    output_path: data.output_path || "暂无",
    output_purpose: data.output_purpose || "暂无",
    active_step_session: activeSession
      ? `${activeSession.stage}.${activeSession.step_id} / ${activeSession.selected_skill || activeSession.skill || activeSession.selected_worker} / ${activeSession.status}`
      : "暂无",
    next_action: data.workflow_selection_required
      ? "请先选择要续接的 workflow"
      : data.next_required_action || data.instruction || "根据当前结论继续",
  };
  return {
    ...data,
    user_output_slots: slots,
    ai_rendering_required: "Render the final user-facing response with ## 先看这里 and user_output_slots. Do not use ## 先看这里 for intermediate progress, tool status, routing handoff, or internal checks.",
  };
}

function stepAt(stageId, stepIndex) {
  if (!stageId) return null;
  const stage = getStage(stageId);
  return (stage.default_steps || [])[stepIndex] || null;
}

function userDefaultSkillFor(stageId, stepId) {
  if (!stageId || !stepId) return null;
  return readSkillRegistry().default_skills.find((entry) => entry.stage === stageId && entry.step_id === stepId) || null;
}

function effectiveDefaultSkillFor(stageId, step) {
  if (!stageId || !step) return null;
  const userDefault = userDefaultSkillFor(stageId, step.step_id);
  if (userDefault && userDefault.skill) {
    return {
      skill: userDefault.skill,
      source: "user_default",
      reason: userDefault.reason || "",
      system_default_skill: step.default_worker || null,
    };
  }
  return {
    skill: step.default_worker || null,
    source: "system_default",
    reason: "",
    system_default_skill: step.default_worker || null,
  };
}

function effectiveStepFor(stageId, step) {
  if (!step) return null;
  const effectiveDefault = effectiveDefaultSkillFor(stageId, step);
  const candidateWorkers = Array.from(new Set([
    effectiveDefault && effectiveDefault.skill,
    step.default_worker,
    ...(step.candidate_workers || []),
  ].filter(Boolean)));
  return {
    ...step,
    default_worker: effectiveDefault ? effectiveDefault.skill : step.default_worker,
    system_default_worker: step.default_worker || null,
    default_worker_source: effectiveDefault ? effectiveDefault.source : "system_default",
    default_worker_reason: effectiveDefault ? effectiveDefault.reason : "",
    candidate_workers: candidateWorkers,
  };
}

function stageSubstepContext(stageId, stepIndex, status) {
  if (!stageId || status === "completed") {
    return {
      current_stage: stageId || null,
      current_stage_substep: null,
      current_stage_substep_default_worker: null,
      current_stage_substep_default_source: null,
      current_stage_substep_system_default_worker: null,
      next_stage: null,
      next_stage_substep: null,
    };
  }
  const stage = getStage(stageId);
  const currentIndex = Number.isInteger(stepIndex) ? stepIndex : 0;
  const currentStep = effectiveStepFor(stageId, stepAt(stageId, currentIndex));
  const nextInCurrentStage = stepAt(stageId, currentIndex + 1);
  if (currentStep) {
    if (nextInCurrentStage) {
      return {
        current_stage: stageId,
        current_stage_substep: currentStep.step_id,
        current_stage_substep_default_worker: currentStep.default_worker || null,
        current_stage_substep_default_source: currentStep.default_worker_source || "system_default",
        current_stage_substep_system_default_worker: currentStep.system_default_worker || currentStep.default_worker || null,
        next_stage: stageId,
        next_stage_substep: nextInCurrentStage.step_id,
      };
    }
    if (stage.next_stage) {
      const nextStageFirstStep = stepAt(stage.next_stage, 0);
      return {
        current_stage: stageId,
        current_stage_substep: currentStep.step_id,
        current_stage_substep_default_worker: currentStep.default_worker || null,
        current_stage_substep_default_source: currentStep.default_worker_source || "system_default",
        current_stage_substep_system_default_worker: currentStep.system_default_worker || currentStep.default_worker || null,
        next_stage: stage.next_stage,
        next_stage_substep: nextStageFirstStep ? nextStageFirstStep.step_id : null,
      };
    }
    return {
      current_stage: stageId,
      current_stage_substep: currentStep.step_id,
      current_stage_substep_default_worker: currentStep.default_worker || null,
      current_stage_substep_default_source: currentStep.default_worker_source || "system_default",
      current_stage_substep_system_default_worker: currentStep.system_default_worker || currentStep.default_worker || null,
      next_stage: null,
      next_stage_substep: null,
    };
  }
  if (stage.next_stage) {
    const nextStageFirstStep = stepAt(stage.next_stage, 0);
    return {
      current_stage: stageId,
      current_stage_substep: null,
      current_stage_substep_default_worker: null,
      current_stage_substep_default_source: null,
      current_stage_substep_system_default_worker: null,
      next_stage: stage.next_stage,
      next_stage_substep: nextStageFirstStep ? nextStageFirstStep.step_id : null,
    };
  }
  return {
    current_stage: stageId,
    current_stage_substep: null,
    current_stage_substep_default_worker: null,
    current_stage_substep_default_source: null,
    current_stage_substep_system_default_worker: null,
    next_stage: null,
    next_stage_substep: null,
  };
}

function stageSubstepContextFromState(state) {
  if (!state) {
    return stageSubstepContext(null, 0, null);
  }
  return stageSubstepContext(state.current_stage, state.current_step_index || 0, state.status);
}

function stageSubstepContextFromData(data) {
  const workflow = data.workflow || null;
  if (workflow && workflow.current_stage) {
    return stageSubstepContextFromState(workflow);
  }
  const stageId = data.current_stage || data.stage || null;
  if (!stageId) {
    return stageSubstepContext(null, 0, null);
  }
  let stepIndex = Number.isInteger(data.current_step_index) ? data.current_step_index : null;
  if (stepIndex === null && data.next_step && data.next_step.step_id) {
    const stage = getStage(stageId);
    stepIndex = (stage.default_steps || []).findIndex((step) => step.step_id === data.next_step.step_id);
  }
  return stageSubstepContext(stageId, stepIndex === null || stepIndex < 0 ? 0 : stepIndex, data.status);
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferContextType(ref, explicitType) {
  if (explicitType) return explicitType;
  const value = String(ref || "").toLowerCase();
  if (/^https?:\/\//.test(value)) {
    if (value.includes("feishu.cn")) return "feishu-doc";
    return "url";
  }
  if (value.endsWith(".md") || value.endsWith(".txt") || value.endsWith(".json") || value.endsWith(".yaml") || value.endsWith(".yml")) {
    return "file";
  }
  return "material-reference";
}

function defaultCallHint(entry) {
  if (entry.call_hint) return entry.call_hint;
  const ref = String(entry.ref || "");
  switch (entry.type) {
    case "feishu-doc":
      return "Use an available document connector to read the linked document with the user-authorized identity.";
    case "file":
      return "Read the local file content before routing or continuing.";
    case "directory":
      return "Inspect relevant files under the local directory before routing or continuing.";
    case "url":
      return "Read the linked page content before routing or continuing.";
    case "repository":
      return "Inspect repository structure and relevant files before routing or continuing.";
    default:
      return ref.startsWith("http") ? "Read the referenced content before routing or continuing." : "Inspect this context entry when it may affect the current workflow.";
  }
}

function normalizeContextEntry(args, existing = {}) {
  const ref = args.ref || existing.ref;
  const id = args.id || existing.id || createContextId(args.title || ref);
  const now = nowIso();
  if (!ref) {
    throw new Error("missing project context ref");
  }
  const entry = {
    ...existing,
    id,
    title: args.title || existing.title || id,
    type: inferContextType(ref, args.type || existing.type),
    ref,
    scope: args.scope || existing.scope || "project",
    workflow_id: args["workflow-id"] || existing.workflow_id || null,
    stages: splitList(args.stages || args.stage).length ? splitList(args.stages || args.stage) : (existing.stages || []),
    skills: splitList(args.skills || args.skill).length ? splitList(args.skills || args.skill) : (existing.skills || []),
    usage: args.usage || existing.usage || "",
    call_hint: args["call-hint"] || existing.call_hint || "",
    access: args.access || existing.access || "project",
    updated_at: now,
    created_at: existing.created_at || now,
  };
  entry.call_hint = defaultCallHint(entry);
  return entry;
}

function createContextId(value) {
  return String(value || "context")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "context";
}

function projectContextEntries(workflowRoot, filters = {}) {
  const context = readProjectContext(workflowRoot);
  return context.entries
    .filter((entry) => !filters.workflowId || !entry.workflow_id || entry.workflow_id === filters.workflowId)
    .filter((entry) => !filters.stage || !entry.stages || entry.stages.length === 0 || entry.stages.includes(filters.stage))
    .filter((entry) => !filters.skill || !entry.skills || entry.skills.length === 0 || entry.skills.includes(filters.skill))
    .map((entry) => ({
      ...entry,
      call_hint: defaultCallHint(entry),
      match_score: contextMatchScore(entry, filters.material),
    }))
    .sort((left, right) => right.match_score - left.match_score || String(left.id).localeCompare(String(right.id)));
}

function contextMatchScore(entry, material) {
  const materialText = normalizeText(material);
  if (!materialText) return 0;
  const text = normalizeText([
    entry.id,
    entry.title,
    entry.type,
    entry.ref,
    entry.usage,
    entry.call_hint,
    ...(entry.stages || []),
    ...(entry.skills || []),
  ].join(" "));
  if (text.includes(materialText)) return 5;
  return materialText
    .split(/[\s/\\:_?&=#.-]+/)
    .filter((item) => item.length >= 2)
    .reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
}

function safePathPart(value) {
  return String(value || "item")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function createRunId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function resolveOutputPath(workflowRoot, outputPath) {
  if (!outputPath) return null;
  return path.isAbsolute(outputPath)
    ? outputPath
    : path.resolve(workflowRoot, outputPath);
}

function relativeOutputPath(workflowRoot, outputPath) {
  if (!outputPath) return null;
  const absolutePath = resolveOutputPath(workflowRoot, outputPath);
  return path.relative(path.resolve(workflowRoot), absolutePath) || ".";
}

function artifactDirFor(workflowRoot, workflowId, stage, stepId, runId) {
  return path.join(
    kfcStateRoot(workflowRoot),
    "workflows",
    workflowId,
    "artifacts",
    safePathPart(stage),
    safePathPart(stepId),
    safePathPart(runId || createRunId()),
  );
}

function suggestedOutputPathFor(workflowRoot, workflowId, stage, stepId, runId) {
  return path.join(artifactDirFor(workflowRoot, workflowId, stage, stepId, runId), `${safePathPart(stepId)}.md`);
}

function outputInspection(workflowRoot, output) {
  const absolutePath = resolveOutputPath(workflowRoot, output.output_path);
  const result = {
    ...output,
    absolute_path: absolutePath,
    relative_path: absolutePath ? path.relative(path.resolve(workflowRoot), absolutePath) : null,
    exists: false,
    readable: false,
  };
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return result;
  }
  const stat = fs.statSync(absolutePath);
  result.exists = true;
  result.size = stat.size;
  result.mtime = stat.mtime.toISOString();
  result.is_directory = stat.isDirectory();
  if (stat.isFile()) {
    try {
      result.preview = fs.readFileSync(absolutePath, "utf8").slice(0, 800);
      result.readable = true;
      result.content_stage_hint = inferStage(result.preview);
      result.content_stage_assessment_required = true;
    } catch (error) {
      result.read_error = error.message;
    }
  }
  return result;
}

function materialTokens(value) {
  return normalizeText(value)
    .split(/[\s/\\:_?&=#.,，。；;()[\]{}<>-]+/)
    .filter((item) => item.length >= 2)
    .slice(0, 40);
}

function outputCoversMaterial(output, material) {
  const tokens = materialTokens(material);
  if (!tokens.length || !output) return false;
  const text = normalizeText([
    output.output_path,
    output.output_purpose,
    output.produced_by,
    output.preview,
    ...(output.material_refs || []),
  ].join(" "));
  if (!text) return false;
  const hits = tokens.filter((token) => text.includes(token)).length;
  return hits >= Math.min(3, tokens.length);
}

function flowNodeCheck(workflowRoot, state, material, stage, materialInspection) {
  const inspectedMaterial = materialInspection || inspectMaterial(material, workflowRoot);
  if (!state) {
    return {
      ai_decision_required: true,
      material_seen: false,
      matched_materials: [],
      existing_outputs: [],
      completed_step_ids: [],
      missing_output_refs: [],
      state_stage: null,
      state_stage_substep: null,
      inferred_material_stage: stage || inferStage(inspectedMaterial.content_for_stage || material),
      recommended_action: "create_or_select_workflow",
      required_ai_checks: [
        "read the current material content",
        "create or select a workflow before generating outputs",
        "decide the correct stage and stage substep from material content",
      ],
    };
  }
  const normalizedMaterial = normalizeText(material);
  const materials = state.materials || [];
  const outputs = state.outputs || [];
  const matchedMaterials = normalizedMaterial
    ? materials.filter((item) => {
      const itemMaterial = normalizeText(item.material);
      return itemMaterial && (itemMaterial === normalizedMaterial || itemMaterial.includes(normalizedMaterial) || normalizedMaterial.includes(itemMaterial));
    })
    : [];
  const inspectedOutputs = outputs.map((output) => outputInspection(workflowRoot, output));
  const completedStepIds = outputs.map((output) => output.step_id).filter(Boolean);
  const sameStageOutputs = inspectedOutputs.filter((output) => !stage || output.stage === stage);
  const materialCoveredOutputs = inspectedOutputs.filter((output) => outputCoversMaterial(output, material));
  const missingOutputRefs = inspectedOutputs.filter((output) => output.output_path && !output.exists);
  const unreadableOutputs = inspectedOutputs.filter((output) => output.exists && !output.readable && !output.is_directory);
  const currentStep = nextStep(state);
  const inferredMaterialStage = stage || inferStage(inspectedMaterial.content_for_stage || material);
  const outputStageHints = inspectedOutputs
    .filter((output) => output.content_stage_hint)
    .map((output) => ({
      output_path: output.output_path,
      recorded_stage: output.stage,
      content_stage_hint: output.content_stage_hint,
    }));
  const focusAlignment = {
    state_material_aligned: !inferredMaterialStage || state.current_stage === inferredMaterialStage,
    state_stage: state.current_stage,
    material_stage: inferredMaterialStage,
    output_stage_hints: outputStageHints,
    wording: "状态 / 材料 / 产物焦点是否一致",
  };
  let recommendedAction = "decide_focus_stage_and_stage_substep";
  if (missingOutputRefs.length) {
    recommendedAction = "repair_or_regenerate_missing_outputs";
  } else if (materialCoveredOutputs.length) {
    recommendedAction = "reuse_existing_outputs_or_continue_from_them";
  } else if (matchedMaterials.length && inspectedOutputs.length) {
    recommendedAction = "inspect_existing_outputs_before_generating";
  } else if (inspectedOutputs.length) {
    recommendedAction = "inspect_existing_outputs_and_decide_next_node";
  }
  return {
    ai_decision_required: true,
    material_seen: matchedMaterials.length > 0,
    matched_materials: matchedMaterials,
    existing_outputs: sameStageOutputs.length ? sameStageOutputs : inspectedOutputs,
    missing_output_refs: missingOutputRefs,
    unreadable_outputs: unreadableOutputs,
    material_covered_by_outputs: materialCoveredOutputs,
    completed_step_ids: completedStepIds,
    state_stage: state.current_stage,
    state_stage_substep: currentStep ? currentStep.step_id : null,
    state_stage_substep_index: state.current_step_index || 0,
    inferred_material_stage: inferredMaterialStage,
    focus_alignment: focusAlignment,
    output_stage_hints: outputStageHints,
    recommended_action: recommendedAction,
    required_ai_checks: [
      "read the current material content",
      "read existing output files when they exist and are readable",
      "judge whether the current material content belongs to the recorded state stage or another stage",
      "judge whether each existing output content fits its recorded stage and stage substep",
      "judge whether existing outputs already cover the current material",
      "decide the focus stage and current stage substep from material, outputs and state together",
      "reuse or continue from existing outputs when they already cover the material",
      "ask the user before overwriting, regenerating or ignoring an existing output",
    ],
  };
}

function recentMaterialRefs(state, explicitMaterial) {
  if (explicitMaterial) return [explicitMaterial];
  return (state.materials || [])
    .map((item) => item.material)
    .filter(Boolean)
    .slice(-5);
}

function getStage(stageId) {
  const steps = readStageSteps();
  const stage = steps.stages[stageId];
  if (!stage) {
    throw new Error(`unknown stage: ${stageId}`);
  }
  return stage;
}

function nextStep(state) {
  const stage = getStage(state.current_stage);
  const steps = stage.default_steps || [];
  return effectiveStepFor(state.current_stage, steps[state.current_step_index] || null);
}

function activeStepSession(state) {
  const session = state && state.active_step_session;
  if (!session || session.status !== "in_progress") return null;
  return session;
}

function activeStepForSession(session) {
  if (!session || !session.stage || !session.step_id) return null;
  const index = stepIndexById(session.stage, session.step_id);
  if (index < 0) return null;
  return effectiveStepFor(session.stage, getStage(session.stage).default_steps[index]);
}

function stepSessionInstruction(session) {
  if (!session) return "";
  const skill = session.selected_skill || session.skill || session.selected_worker || "the selected skill";
  return `Continue the active KFC step session with ${skill}. Do not advance to another KFC step until this skill decides the step output is ready, writes or places the output under ${session.suggested_output_dir}, and complete records the output path and purpose.`;
}

function stepIndexById(stageId, stepId) {
  const stage = getStage(stageId);
  return (stage.default_steps || []).findIndex((step) => step.step_id === stepId);
}

function isAtOrAfterIso(value, sinceIso) {
  if (!sinceIso) return true;
  if (!value) return false;
  const valueTime = Date.parse(value);
  const sinceTime = Date.parse(sinceIso);
  if (Number.isNaN(valueTime) || Number.isNaN(sinceTime)) return false;
  return valueTime >= sinceTime;
}

function completedStepIdsForStage(state, stageId, sinceIso = null) {
  return (state.outputs || [])
    .filter((output) => output.stage === stageId)
    .filter((output) => isAtOrAfterIso(output.completed_at, sinceIso))
    .map((output) => output.step_id)
    .filter(Boolean);
}

function currentQualityGateUserDecisions(state) {
  const tracking = state && state.quality_gate_tracking;
  if (!tracking || !tracking.dev_work_changed) return [];
  const latestByStep = new Map();
  for (const decision of state.user_decisions || []) {
    if (!decision || !qualityGateStepIds.includes(decision.step_id)) continue;
    if (decision.action !== "manual-pass" && decision.action !== "skip-gate") continue;
    if (!isAtOrAfterIso(decision.recorded_at, tracking.last_code_change_at)) continue;
    const previous = latestByStep.get(decision.step_id);
    if (!previous || Date.parse(decision.recorded_at) >= Date.parse(previous.recorded_at)) {
      latestByStep.set(decision.step_id, decision);
    }
  }
  return Array.from(latestByStep.values());
}

function pendingQualityGateSteps(state) {
  const tracking = state && state.quality_gate_tracking;
  if (!tracking || !tracking.dev_work_changed) return [];
  const completed = new Set(completedStepIdsForStage(state, qualityGateStage, tracking.last_code_change_at));
  const decided = new Set(currentQualityGateUserDecisions(state).map((decision) => decision.step_id));
  const pending = Array.isArray(tracking.pending_quality_gates)
    ? tracking.pending_quality_gates
    : qualityGateStepIds;
  return pending.filter((stepId) => qualityGateStepIds.includes(stepId) && !completed.has(stepId) && !decided.has(stepId));
}

function normalizeQualityGateTracking(state) {
  const tracking = state.quality_gate_tracking || {};
  const pending = pendingQualityGateSteps({
    ...state,
    quality_gate_tracking: {
      ...tracking,
      dev_work_changed: tracking.dev_work_changed !== false,
      pending_quality_gates: tracking.pending_quality_gates || qualityGateStepIds,
    },
  });
  state.quality_gate_tracking = {
    ...tracking,
    dev_work_changed: pending.length > 0,
    quality_gate_stage: qualityGateStage,
    pending_quality_gates: pending,
    completed_quality_gates: qualityGateStepIds.filter((stepId) => !pending.includes(stepId)),
    user_decision_quality_gates: currentQualityGateUserDecisions(state),
    updated_at: nowIso(),
  };
  return state.quality_gate_tracking;
}

function stageIsComplete(state) {
  return nextStep(state) === null;
}

function parsePatterns(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function registrySkills(workflowRoot, stageId) {
  if (!stageId) return [];
  return readSkillRegistry().entries
    .filter((entry) => entry.stage === stageId)
    .map((entry) => ({
      name: entry.skill,
      summary: entry.summary || entry.strategy || "KFC 全局动态接入的 skill。",
      stage: entry.stage,
      step_id: entry.step_id,
      strategy: entry.strategy || "",
      patterns: entry.patterns || [],
      source: "global_skill_registry",
      registry_source: entry.registry_source || "user",
    }));
}

function registrySkillsForStep(stageId, stepId) {
  if (!stageId || !stepId) return [];
  return readSkillRegistry().entries
    .filter((entry) => entry.stage === stageId && entry.step_id === stepId)
    .map((entry) => entry.skill)
    .filter(Boolean);
}

function allowedDefaultSkillsForStep(stageId, step) {
  if (!stageId || !step) return [];
  return Array.from(new Set([
    step.default_worker,
    ...(step.candidate_workers || []),
    ...registrySkillsForStep(stageId, step.step_id),
  ].filter(Boolean)));
}

function availableSkills(stageId, workflowRoot) {
  const skills = [...stageCatalog(stageId).skills];
  const stage = stageId ? getStage(stageId) : null;
  for (const step of stage && stage.default_steps || []) {
    for (const name of [step.default_worker, ...(step.candidate_workers || [])].filter(Boolean)) {
      if (!skills.some((skill) => skill.name === name)) {
        skills.push({
          name,
          summary: step.output_purpose || "KFC effective stage step skill.",
          stage: stageId,
          step_id: step.step_id,
          source: step.source === "user_added" || step.source === "user_override" ? "effective_step_registry" : "stage_steps",
        });
      }
    }
  }
  for (const item of registrySkills(workflowRoot, stageId)) {
    const existing = skills.find((skill) => skill.name === item.name);
    if (existing) {
      existing.dynamic_registrations = existing.dynamic_registrations || [];
      existing.dynamic_registrations.push({
        stage: item.stage,
        step_id: item.step_id,
        strategy: item.strategy,
        patterns: item.patterns,
      });
    } else {
      skills.push(item);
    }
  }
  return skills;
}

function localSkillRoots(args = {}) {
  const home = os.homedir();
  const configured = args["skills-root"] ? String(args["skills-root"]).split(path.delimiter).filter(Boolean) : [
    path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills"),
  ];
  return Array.from(new Set([skillsRoot, ...configured]));
}

function catalogRequiredSkills() {
  const names = new Set();
  for (const stage of Object.values(readWorkerCatalog().stages || {})) {
    for (const skill of stage.skills || []) if (skill.name) names.add(skill.name);
  }
  for (const stage of Object.values(readStageSteps().stages || {})) {
    for (const step of stage.default_steps || []) {
      for (const name of [step.default_worker, ...(step.candidate_workers || [])].filter(Boolean)) names.add(name);
    }
  }
  return [...names].sort();
}

function skillExists(skillName, roots) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName || "")) return false;
  return roots.some((root) => fs.existsSync(path.join(root, skillName, "SKILL.md")));
}

function ensureSkill(skillName, args) {
  const roots = localSkillRoots(args);
  const installed = skillExists(skillName, roots);
  return {
    skill: skillName, required: /^(?:kfc|kfc-)/.test(skillName || ''), installed: installed || !/^(?:kfc|kfc-)/.test(skillName || ''), install_attempted: false, checked_roots: roots,
    blocking_reason: installed ? null : "selected_skill_missing",
  };
}

function nextRunnableStep(state) {
  const step = nextStep(state);
  return { step, decision: { action: step ? "run" : "complete" }, skipped: [] };
}

function advanceStageIfNeeded(state) {
  if (!stageIsComplete(state)) return state;
  const stage = getStage(state.current_stage);
  if (!stage.next_stage) {
    state.status = "completed";
    state.updated_at = nowIso();
    return state;
  }
  state.current_stage = stage.next_stage;
  state.current_step_index = 0;
  state.stage_history.push({
    stage: state.current_stage,
    entered_at: nowIso(),
    reason: "previous_stage_completed",
  });
  state.updated_at = nowIso();
  return state;
}

function requireWorkflow(workflowRoot, workflowId) {
  const resolved = resolveWorkflow(workflowRoot, workflowId);
  if (!resolved.state) {
    throw new Error("no workflow found; run init first or pass --workflow-id");
  }
  return resolved.state;
}

function commandInit(args) {
  const workflowRoot = args.root || process.cwd();
  const materialInspection = inspectMaterial(args.material || "", workflowRoot);
  const focus = resolveFlowFocus({
    workflowRoot,
    state: null,
    material: args.material || args.title || "",
    materialInspection,
    explicitStage: args.stage,
  });
  const stage = focus.stage;
  const state = createWorkflowState({
    workflowId: args["workflow-id"],
    title: args.title || args["workflow-id"] || "KFC workflow",
    stage,
    material: args.material,
  });
  state.flow_focus_history = state.flow_focus_history || [];
  state.flow_focus_history.push({
    resolved_at: nowIso(),
    source: "init",
    material: args.material || args.title || "",
    inferred_stage: focus.inferred_stage,
    resolved_stage: stage,
    stage_evidence: focus.stage_evidence,
  });
  writeWorkflowState(workflowRoot, state);
  upsertActiveWorkflow(workflowRoot, state, { makeDefault: args.default !== false });
  const substepContext = stageSubstepContextFromState(state);
  return {
    ok: true,
    message: "workflow initialized",
    ...workflowRootInfo(workflowRoot),
    state_root: kfcStateRoot(workflowRoot),
    workflow_id: state.workflow_id,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    next_stage: substepContext.next_stage,
    next_stage_substep: substepContext.next_stage_substep,
    stage_substep_context: substepContext,
    next_step: nextStep(state),
    available_skills: availableSkills(state.current_stage, workflowRoot),
    material_inspection: materialInspection,
    stage_evidence: focus.stage_evidence,
    flow_node_check: flowNodeCheck(workflowRoot, state, args.material || "", state.current_stage, materialInspection),
  };
}

function commandCurrent(args) {
  const workflowRoot = args.root || process.cwd();
  const active = readActiveWorkflows(workflowRoot);
  const state = args["workflow-id"] || active.default_workflow_id
    ? readWorkflowState(workflowRoot, args["workflow-id"] || active.default_workflow_id)
    : null;
  const substepContext = stageSubstepContextFromState(state);
  const session = activeStepSession(state);
  return {
    ok: true,
    ...workflowRootInfo(workflowRoot),
    root_diagnostics: rootDiagnostics(workflowRoot),
    state_root: kfcStateRoot(workflowRoot),
    default_workflow_id: active.default_workflow_id,
    workflows: active.workflows,
    workflow: state,
    active_step_session: session,
    next_required_action: session ? "continue_active_step_session" : "inspect_current_kfc_state",
    current_stage: state && state.current_stage,
    next_stage: substepContext.next_stage,
    next_stage_substep: substepContext.next_stage_substep,
    stage_substep_context: substepContext,
    next_step: session ? activeStepForSession(session) : state && nextStep(state),
    available_skills: state && state.status !== "completed" ? availableSkills(state.current_stage, workflowRoot) : [],
    project_context_entries: projectContextEntries(workflowRoot, {
      workflowId: state && state.workflow_id,
      stage: state && state.current_stage,
    }),
    flow_node_check: flowNodeCheck(workflowRoot, state, "", state && state.current_stage),
    ai_required_actions: session
      ? [
          "continue the active KFC step session; do not re-route or advance the step",
          `load and use skill: ${session.selected_skill || session.skill || session.selected_worker}`,
          "only run complete after the active skill decides the step output is ready",
        ]
      : [],
  };
}

function commandCatalog(args) {
  const workflowRoot = args.root || process.cwd();
  const stageId = args.stage || (args["workflow-id"] ? requireWorkflow(workflowRoot, args["workflow-id"]).current_stage : null);
  if (!stageId) return readWorkerCatalog();
  const stage = getStage(stageId);
  return {
    ok: true,
    ...workflowRootInfo(workflowRoot),
    root_diagnostics: rootDiagnostics(workflowRoot),
    stage: stageId,
    next_stage: stage.next_stage,
    steps: (stage.default_steps || []).map((step) => effectiveStepFor(stageId, step)),
    available_skills: availableSkills(stageId, workflowRoot),
  };
}

function commandRoute(args) {
  const workflowRoot = args.root || process.cwd();
  const material = args.material || args._.slice(1).join(" ");
  const materialInspection = inspectMaterial(material, workflowRoot);
  const initialFocus = resolveFlowFocus({
    workflowRoot,
    state: null,
    material,
    materialInspection,
    explicitStage: args.stage,
  });
  const stage = initialFocus.stage;
  const active = readActiveWorkflows(workflowRoot);
  const activeWorkflows = (active.workflows || []).filter((summary) => summary && summary.status !== "completed");
  const candidates = workflowCandidates(workflowRoot, material, stage);
  let state = null;
  let workflowAutoInitialized = false;
  if (args["workflow-id"]) {
    state = readWorkflowState(workflowRoot, args["workflow-id"]);
    if (state && state.status === "completed") {
      return {
        ok: false,
        message: "workflow is closed; route new material without this workflow id",
        ...workflowRootInfo(workflowRoot),
        workflow_id: state.workflow_id,
        reason: state.closed_by_user_decision ? "workflow_closed_by_user_instruction" : "workflow_completed",
        user_decision: state.closed_by_user_decision || null,
      };
    }
  } else if (candidates.length === 1 && candidates[0].match_score >= 2) {
    state = readWorkflowState(workflowRoot, candidates[0].workflow_id);
  } else if (activeWorkflows.length > 1 && material) {
    return {
      ok: false,
      message: "workflow selection required",
      ...workflowRootInfo(workflowRoot),
      workflow_selection_required: true,
      candidate_workflows: candidates.length ? candidates : activeWorkflows,
      inferred_stage: initialFocus.inferred_stage,
      current_stage: stage,
      stage_evidence: initialFocus.stage_evidence,
      material_inspection: materialInspection,
      ai_required_actions: [
        "read or inspect the material content",
        "inspect project context entries when they are relevant to the material",
        "inspect existing workflow outputs before generating new output",
        "compare the material with candidate workflows",
        "ask the user to choose when no single workflow is clear",
      ],
      available_skills: availableSkills(stage, workflowRoot),
      project_context_entries: projectContextEntries(workflowRoot, { stage, material }),
      flow_node_check: {
        recommended_action: "select_workflow_then_inspect_outputs",
        candidate_flow_node_checks: (candidates.length ? candidates : activeWorkflows).map((item) => ({
          workflow_id: item.workflow_id,
          match_score: item.match_score || 0,
          flow_node_check: flowNodeCheck(workflowRoot, readWorkflowState(workflowRoot, item.workflow_id), material, stage, materialInspection),
        })),
      },
    };
  } else {
    state = active.default_workflow_id ? readWorkflowState(workflowRoot, active.default_workflow_id) : null;
    if (!state || state.status === "completed") {
      state = activeWorkflows.length === 1
        ? readWorkflowState(workflowRoot, activeWorkflows[0].workflow_id)
        : null;
    }
    if (!state) {
      state = createWorkflowState({
        workflowId: args["workflow-id"],
        title: args.title || String(material || stage).slice(0, 48) || "KFC workflow",
        stage,
        material,
      });
      state.flow_focus_history = state.flow_focus_history || [];
      state.flow_focus_history.push({
        resolved_at: nowIso(),
        source: "route_auto_init",
        material,
        inferred_stage: initialFocus.inferred_stage,
        resolved_stage: stage,
        stage_evidence: initialFocus.stage_evidence,
      });
      writeWorkflowState(workflowRoot, state);
      upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
      workflowAutoInitialized = true;
    }
  }
  const existingSession = activeStepSession(state);
  if (existingSession && !args.stage) {
    return {
      ok: true,
      ...workflowRootInfo(workflowRoot),
      message: "active step session still in progress; material should feed the current selected skill",
      workflow_id: state.workflow_id,
      workflow_selection: "selected",
      current_stage: state.current_stage,
      current_step_index: state.current_step_index,
      active_step_session: existingSession,
      next_required_action: "continue_active_step_session",
      stage_substep_context: stageSubstepContextFromState(state),
      next_step: activeStepForSession(existingSession),
      selected_skill: existingSession.selected_skill || existingSession.skill,
      selected_worker: existingSession.selected_worker || existingSession.selected_skill || existingSession.skill,
      material_inspection: materialInspection,
      available_skills: availableSkills(existingSession.stage || state.current_stage, workflowRoot),
      project_context_entries: projectContextEntries(workflowRoot, {
        workflowId: state.workflow_id,
        stage: existingSession.stage || state.current_stage,
        material,
        skill: existingSession.selected_skill || existingSession.skill,
      }),
      flow_node_check: flowNodeCheck(workflowRoot, state, material, existingSession.stage || state.current_stage, materialInspection),
      ai_required_actions: [
        "treat this material as input to the active KFC step session",
        `continue the active selected skill: ${existingSession.selected_skill || existingSession.skill || existingSession.selected_worker}`,
        "do not re-route or advance the workflow while active_step_session is in_progress",
        "only run complete after the active skill produces a recordable output path and purpose",
      ],
    };
  }
  const focus = resolveFlowFocus({
    workflowRoot,
    state,
    material,
    materialInspection,
    explicitStage: args.stage,
  });
  const focusStage = focus.stage;
  const flowCheckBeforeUpdate = focus.flow_node_check;
  let stageUpdateApplied = false;
  if (state) {
    const previousStage = state.current_stage;
    const shouldUpdateStage = Boolean(args.stage) || state.current_stage === focusStage;
    stageUpdateApplied = shouldUpdateStage;
    if (shouldUpdateStage) {
      state.current_stage = focusStage;
      state.current_step_index = previousStage === focusStage
        ? Math.min(state.current_step_index || 0, (getStage(focusStage).default_steps || []).length)
        : 0;
      if (previousStage !== focusStage) {
        state.stage_history = state.stage_history || [];
        state.stage_history.push({
          stage: focusStage,
          entered_at: nowIso(),
          reason: "route_stage_update",
          previous_stage: previousStage,
        });
      }
    }
    state.materials = state.materials || [];
    if (material) {
      const materialRecord = {
        material,
        recorded_at: nowIso(),
        inferred_stage: focus.inferred_stage,
        resolved_stage: focusStage,
        stage_evidence: focus.stage_evidence,
        state_stage_at_recording: state.current_stage,
        stage_update_applied: shouldUpdateStage,
      };
      const existingMaterialIndex = workflowAutoInitialized
        ? state.materials.findIndex((item) => item.material === material)
        : -1;
      if (existingMaterialIndex >= 0) {
        state.materials[existingMaterialIndex] = {
          ...state.materials[existingMaterialIndex],
          ...materialRecord,
        };
      } else {
        state.materials.push(materialRecord);
      }
    }
    state.flow_focus_history = state.flow_focus_history || [];
    state.flow_focus_history.push({
      resolved_at: nowIso(),
      source: args.stage ? "route_explicit_stage" : "route",
      material,
      inferred_stage: focus.inferred_stage,
      resolved_stage: focusStage,
      state_stage_after_route: state.current_stage,
      stage_update_applied: shouldUpdateStage,
      stage_evidence: focus.stage_evidence,
    });
    state.updated_at = nowIso();
    writeWorkflowState(workflowRoot, state);
    upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
  }
  const substepContext = state
    ? stageSubstepContextFromState(state)
    : stageSubstepContext(focusStage, 0, null);
  return {
    ok: true,
    ...workflowRootInfo(workflowRoot),
    message: workflowAutoInitialized
      ? "workflow auto initialized from material evidence"
      : state
        ? (args.stage ? "workflow routed and stage updated" : "workflow inspected; AI confirmation required before stage update when focus differs")
        : "stage inferred; no workflow updated",
    workflow_id: state && state.workflow_id,
    workflow_selection: state ? "selected" : "not_selected",
    workflow_auto_initialized: workflowAutoInitialized,
    candidate_workflows: candidates,
    current_stage: state ? state.current_stage : focusStage,
    inferred_stage: focus.inferred_stage,
    resolved_stage: focusStage,
    stage_evidence: focus.stage_evidence,
    stage_update_applied: stageUpdateApplied,
    current_step_index: state ? state.current_step_index : 0,
    next_stage: substepContext.next_stage,
    next_stage_substep: substepContext.next_stage_substep,
    stage_substep_context: substepContext,
    next_step: state ? nextStep(state) : effectiveStepFor(focusStage, (getStage(focusStage).default_steps || [])[0] || null),
    available_skills: availableSkills(focusStage, workflowRoot),
    project_context_entries: projectContextEntries(workflowRoot, {
      workflowId: state && state.workflow_id,
      stage: focusStage,
      material,
    }),
    flow_node_check: flowCheckBeforeUpdate,
    material_inspection: materialInspection,
    root_diagnostics: rootDiagnostics(workflowRoot),
    ai_required_actions: [
      "confirm that the material content has been checked",
      "inspect project context entries when they are relevant to the material",
      "inspect flow_node_check.existing_outputs before generating, overwriting or skipping output",
      "decide focus stage and current stage substep from material, existing outputs and KFC state together",
      "render user-facing output with current stage and available skills",
      "ask the user to choose a skill before any skill execution",
      "do not automatically execute the recommended skill",
    ],
  };
}

function commandContinue(args) {
  const workflowRoot = args.root || process.cwd();
  const state = requireWorkflow(workflowRoot, args["workflow-id"]);
  const existingSession = activeStepSession(state);
  if (existingSession) {
    existingSession.last_activity_at = nowIso();
    existingSession.turn_count = (existingSession.turn_count || 1) + 1;
    state.updated_at = nowIso();
    writeWorkflowState(workflowRoot, state);
    upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
    const contextEntries = projectContextEntries(workflowRoot, {
      workflowId: state.workflow_id,
      stage: existingSession.stage,
      skill: existingSession.selected_skill || existingSession.skill,
    });
    return {
      ok: true,
      message: "active step session still in progress",
      workflow_id: state.workflow_id,
      current_stage: state.current_stage,
      current_step_index: state.current_step_index,
      active_step_session: existingSession,
      next_required_action: "continue_active_step_session",
      stage_substep_context: stageSubstepContextFromState(state),
      next_step: activeStepForSession(existingSession),
      selected_skill: existingSession.selected_skill || existingSession.skill,
      selected_worker: existingSession.selected_worker || existingSession.selected_skill || existingSession.skill,
      output_purpose: existingSession.output_purpose,
      project_context_entries: contextEntries,
      flow_node_check: flowNodeCheck(workflowRoot, state, "", state.current_stage),
      run_id: existingSession.run_id,
      suggested_output_dir: existingSession.suggested_output_dir,
      suggested_output_path: existingSession.suggested_output_path,
      instruction: stepSessionInstruction(existingSession),
      ai_required_actions: [
        "do not start another KFC step while active_step_session is in_progress",
        `load and use skill: ${existingSession.selected_skill || existingSession.skill || existingSession.selected_worker}`,
        "continue the multi-turn skill session when the skill needs more user input",
        "only run complete after the active skill produces a recordable output",
      ],
    };
  }
  advanceStageIfNeeded(state);
  const runnable = nextRunnableStep(state, args);
  const step = runnable.step;
  if (!step) {
    writeWorkflowState(workflowRoot, state);
    upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
    return {
      ok: true,
      message: "workflow has no next step",
      workflow_id: state.workflow_id,
      current_stage: state.current_stage,
      status: state.status,
      available_skills: availableSkills(state.current_stage, workflowRoot),
    };
  }

  const selectedWorker = args.skill || args.worker || step.default_worker;
  const dependencyCheck = ensureSkill(selectedWorker, args);
  if (dependencyCheck.required && !dependencyCheck.installed) {
    writeWorkflowState(workflowRoot, state);
    upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
    return {
      ok: false,
      message: "selected skill is missing; automatic installation is disabled",
      workflow_id: state.workflow_id,
      current_stage: state.current_stage,
      current_step_index: state.current_step_index,
      next_step: step,
      selected_skill: selectedWorker,
      selected_worker: selectedWorker,
      dependency_check: dependencyCheck,
      blocking_reason: dependencyCheck.blocking_reason,
      available_skills: availableSkills(state.current_stage, workflowRoot),
      ai_required_actions: [
        "show the missing skill and its checked locations to the user",
        "do not silently skip the selected skill",
        "select a bundled worker or explicitly install the missing skill before retrying",
      ],
    };
  }
  const runId = createRunId();
  const suggestedOutputDir = artifactDirFor(workflowRoot, state.workflow_id, state.current_stage, step.step_id, runId);
  const suggestedOutputPath = suggestedOutputPathFor(workflowRoot, state.workflow_id, state.current_stage, step.step_id, runId);
  fs.mkdirSync(suggestedOutputDir, { recursive: true });
  const contextEntries = projectContextEntries(workflowRoot, {
    workflowId: state.workflow_id,
    stage: state.current_stage,
    skill: selectedWorker,
  });
  const flowCheck = flowNodeCheck(workflowRoot, state, "", state.current_stage);
  const record = {
    stage: state.current_stage,
    step_id: step.step_id,
    selected_skill: selectedWorker,
    selected_worker: selectedWorker,
    default_worker: step.default_worker,
    candidate_workers: step.candidate_workers || [],
    output_purpose: step.output_purpose,
    project_context_entry_ids: contextEntries.map((entry) => entry.id),
    run_id: runId,
    suggested_output_dir: path.relative(path.resolve(workflowRoot), suggestedOutputDir),
    suggested_output_path: path.relative(path.resolve(workflowRoot), suggestedOutputPath),
    selected_at: nowIso(),
    source: args.skill || args.worker ? "user_override" : "default_step",
  };
  state.active_step_session = {
    session_id: `${state.current_stage}.${step.step_id}.${runId}`,
    status: "in_progress",
    stage: state.current_stage,
    step_id: step.step_id,
    selected_skill: selectedWorker,
    selected_worker: selectedWorker,
    default_worker: step.default_worker,
    candidate_workers: step.candidate_workers || [],
    output_purpose: step.output_purpose,
    run_id: runId,
    suggested_output_dir: record.suggested_output_dir,
    suggested_output_path: record.suggested_output_path,
    completion_policy: "The selected skill decides when this step is complete. KFC advances only after complete records the output path and purpose.",
    started_at: nowIso(),
    last_activity_at: nowIso(),
    turn_count: 1,
    source: record.source,
  };
  state.selected_workers = state.selected_workers || [];
  state.selected_workers.push(record);
  state.updated_at = nowIso();
  writeWorkflowState(workflowRoot, state);
  upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });

  return {
    ok: true,
    message: "next skill selected",
    workflow_id: state.workflow_id,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    next_stage: stageSubstepContextFromState(state).next_stage,
    next_stage_substep: stageSubstepContextFromState(state).next_stage_substep,
    stage_substep_context: stageSubstepContextFromState(state),
    next_step: step,
    selected_skill: selectedWorker,
    selected_worker: selectedWorker,
    active_step_session: state.active_step_session,
    next_required_action: "run_selected_skill_within_active_step_session",
    dependency_check: dependencyCheck,
    output_purpose: step.output_purpose,
    available_skills: availableSkills(state.current_stage, workflowRoot),
    project_context_entries: contextEntries,
    flow_node_check: flowCheck,
    run_id: runId,
    suggested_output_dir: path.relative(path.resolve(workflowRoot), suggestedOutputDir),
    suggested_output_path: path.relative(path.resolve(workflowRoot), suggestedOutputPath),
    instruction: stepSessionInstruction(state.active_step_session),
    ai_required_actions: [
      "enter and keep the active KFC step session until the selected skill is complete",
      "inspect project context entries before using the selected skill when they are relevant",
      "inspect flow_node_check.existing_outputs before generating, overwriting or skipping output",
      "decide focus stage and current stage substep from material, existing outputs and KFC state together",
      `load and use skill: ${selectedWorker}`,
      `write or place the skill output under ${path.relative(path.resolve(workflowRoot), suggestedOutputDir)}`,
      "ensure the skill output includes output path and purpose",
      "run complete only after the active skill decides this step has a recordable output",
    ],
  };
}

function commandComplete(args) {
  const workflowRoot = args.root || process.cwd();
  const state = requireWorkflow(workflowRoot, args["workflow-id"]);
  const session = activeStepSession(state);
  const lastSelection = session || (state.selected_workers || [])[state.selected_workers.length - 1];
  if (!lastSelection) {
    throw new Error("no selected skill to complete; run continue first");
  }
  const runId = lastSelection.run_id || createRunId();
  const expectedOutputDir = artifactDirFor(workflowRoot, state.workflow_id, lastSelection.stage, lastSelection.step_id, runId);
  const defaultOutputPath = path.join(expectedOutputDir, `${safePathPart(lastSelection.step_id)}.md`);
  fs.mkdirSync(expectedOutputDir, { recursive: true });
  const providedOutputPath = args["output-path"] || lastSelection.suggested_output_path || defaultOutputPath;
  const absoluteOutputPath = resolveOutputPath(workflowRoot, providedOutputPath);
  const outputRelativeToExpected = absoluteOutputPath
    ? path.relative(expectedOutputDir, absoluteOutputPath)
    : null;
  const output = {
    stage: lastSelection.stage,
    step_id: lastSelection.step_id,
    stage_substep: lastSelection.step_id,
    run_id: runId,
    produced_by: args.skill || args.worker || lastSelection.selected_skill || lastSelection.selected_worker,
    output_path: relativeOutputPath(workflowRoot, absoluteOutputPath),
    output_purpose: args.purpose || lastSelection.output_purpose || null,
    material_refs: recentMaterialRefs(state, args.material),
    content_stage_assessment: args["content-stage"] || null,
    suggested_output_dir: path.relative(path.resolve(workflowRoot), expectedOutputDir),
    output_in_suggested_dir: outputRelativeToExpected
      ? !outputRelativeToExpected.startsWith("..") && !path.isAbsolute(outputRelativeToExpected)
      : false,
    output_exists_after_complete: absoluteOutputPath ? fs.existsSync(absoluteOutputPath) : false,
    completed_at: nowIso(),
  };
  const inspectedOutput = outputInspection(workflowRoot, output);
  if (!output.content_stage_assessment && inspectedOutput.content_stage_hint) {
    output.content_stage_assessment = inspectedOutput.content_stage_hint;
  }
  output.output_readable_after_complete = inspectedOutput.readable;
  output.output_preview_after_complete = inspectedOutput.preview || null;
  state.outputs = state.outputs || [];
  state.outputs.push(output);
  if (session) {
    const completedSession = {
      ...session,
      status: "completed",
      completed_at: nowIso(),
      output_path: output.output_path,
      output_purpose: output.output_purpose,
      produced_by: output.produced_by,
    };
    state.step_session_history = state.step_session_history || [];
    state.step_session_history.push(completedSession);
    state.active_step_session = null;
  }
  if (output.stage === qualityGateStage && qualityGateStepIds.includes(output.step_id)) {
    const tracking = state.quality_gate_tracking || {};
    const completed = new Set(tracking.completed_quality_gates || []);
    completed.add(output.step_id);
    state.quality_gate_tracking = {
      ...tracking,
      quality_gate_stage: qualityGateStage,
      completed_quality_gates: Array.from(completed).filter((stepId) => qualityGateStepIds.includes(stepId)),
      updated_at: nowIso(),
    };
    normalizeQualityGateTracking(state);
  }
  state.current_step_index = (state.current_step_index || 0) + 1;
  advanceStageIfNeeded(state);
  state.updated_at = nowIso();
  writeWorkflowState(workflowRoot, state);
  upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
  const substepContext = stageSubstepContextFromState(state);
  return {
    ok: true,
    message: "skill output recorded",
    workflow_id: state.workflow_id,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    next_stage: substepContext.next_stage,
    next_stage_substep: substepContext.next_stage_substep,
    stage_substep_context: substepContext,
    output_path: output.output_path,
    output_purpose: output.output_purpose,
    produced_by: output.produced_by,
    suggested_output_dir: output.suggested_output_dir,
    output_in_suggested_dir: output.output_in_suggested_dir,
    output_exists_after_complete: output.output_exists_after_complete,
    quality_gate_tracking: state.quality_gate_tracking || null,
    next_step: state.status === "completed" ? null : nextStep(state),
    available_skills: state.status === "completed" ? [] : availableSkills(state.current_stage, workflowRoot),
  };
}

function commandMarkCodeChange(args) {
  const workflowRoot = args.root || process.cwd();
  const resolved = resolveWorkflow(workflowRoot, args["workflow-id"]);
  if (!resolved.state) {
    return {
      ok: true,
      message: "no active workflow; code change marker skipped",
      ...workflowRootInfo(workflowRoot),
      skipped: true,
      reason: "no_active_workflow",
    };
  }
  const state = resolved.state;
  const now = nowIso();
  const changeRecord = {
    changed_at: now,
    source: args.source || "hook",
    event: args.event || "PostToolUse",
    tool_name: args["tool-name"] || args.tool || null,
    summary: args.summary || null,
  };
  state.quality_gate_tracking = {
    ...(state.quality_gate_tracking || {}),
    dev_work_changed: true,
    quality_gate_stage: qualityGateStage,
    pending_quality_gates: [...qualityGateStepIds],
    completed_quality_gates: [],
    last_code_change_at: now,
    last_code_change_source: changeRecord.source,
    last_code_change_event: changeRecord.event,
    last_code_change_tool_name: changeRecord.tool_name,
    code_change_history: [
      ...((state.quality_gate_tracking && state.quality_gate_tracking.code_change_history) || []).slice(-19),
      changeRecord,
    ],
    updated_at: now,
  };
  state.updated_at = now;
  writeWorkflowState(workflowRoot, state);
  upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
  return {
    ok: true,
    message: "code change marked; quality gates pending",
    ...workflowRootInfo(workflowRoot),
    workflow_id: state.workflow_id,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    quality_gate_tracking: state.quality_gate_tracking,
  };
}

function commandRecordUserDecision(args) {
  const workflowRoot = args.root || process.cwd();
  const state = requireWorkflow(workflowRoot, args["workflow-id"]);
  const action = String(args.action || "").trim();
  const stepId = args.step || args["step-id"] || args.step_id;
  const reason = String(args.reason || "").trim();

  if (!reason) {
    throw new Error("reason is required to record a user decision");
  }

  if (action === "close-workflow") {
    const decision = {
      decision_id: `user-decision-${createRunId()}`,
      action,
      reason,
      source: "user_instruction",
      recorded_at: nowIso(),
    };
    state.user_decisions = [
      ...((state.user_decisions || []).slice(-49)),
      decision,
    ];
    const session = activeStepSession(state);
    if (session) {
      state.step_session_history = state.step_session_history || [];
      state.step_session_history.push({
        ...session,
        status: "cancelled_by_user_instruction",
        cancelled_at: nowIso(),
        user_decision_id: decision.decision_id,
      });
      state.active_step_session = null;
    }
    state.status = "completed";
    state.closed_by_user_decision = decision;
    state.stage_history = state.stage_history || [];
    state.stage_history.push({
      stage: state.current_stage,
      entered_at: nowIso(),
      reason: "closed_by_user_instruction",
      user_decision_id: decision.decision_id,
    });
    state.updated_at = nowIso();
    writeWorkflowState(workflowRoot, state);
    upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
    return {
      ok: true,
      message: "workflow closed by recorded user instruction",
      ...workflowRootInfo(workflowRoot),
      workflow_id: state.workflow_id,
      workflow_status: state.status,
      user_decision: decision,
      active_step_session: null,
    };
  }

  if (action !== "manual-pass" && action !== "skip-gate") {
    throw new Error("action must be manual-pass, skip-gate, or close-workflow");
  }
  if (!qualityGateStepIds.includes(stepId)) {
    throw new Error("step must be a KFC quality gate step");
  }

  const pending = pendingQualityGateSteps(state);
  if (!pending.includes(stepId)) {
    throw new Error("quality gate step is not currently pending");
  }

  const decision = {
    decision_id: `user-decision-${createRunId()}`,
    action,
    step_id: stepId,
    stage: qualityGateStage,
    reason,
    source: "user_instruction",
    recorded_at: nowIso(),
    applies_after_code_change_at: state.quality_gate_tracking && state.quality_gate_tracking.last_code_change_at || null,
  };
  state.user_decisions = [
    ...((state.user_decisions || []).slice(-49)),
    decision,
  ];

  const session = activeStepSession(state);
  if (session && session.stage === qualityGateStage && session.step_id === stepId) {
    state.step_session_history = state.step_session_history || [];
    state.step_session_history.push({
      ...session,
      status: "superseded_by_user_decision",
      superseded_at: nowIso(),
      user_decision_id: decision.decision_id,
      user_decision_action: decision.action,
    });
    state.active_step_session = null;
  }

  normalizeQualityGateTracking(state);
  state.updated_at = nowIso();
  writeWorkflowState(workflowRoot, state);
  upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });

  const remaining = pendingQualityGateSteps(state);
  const nextStepId = remaining[0] || null;
  const nextQualityGateStep = nextStepId
    ? effectiveStepFor(qualityGateStage, getStage(qualityGateStage).default_steps[stepIndexById(qualityGateStage, nextStepId)])
    : null;
  return {
    ok: true,
    message: "user decision recorded for quality gate",
    ...workflowRootInfo(workflowRoot),
    workflow_id: state.workflow_id,
    user_decision: decision,
    pending_quality_gates: remaining,
    next_quality_gate_step: nextQualityGateStep,
    quality_gate_tracking: state.quality_gate_tracking,
  };
}

function commandCloseoutCheck(args) {
  const workflowRoot = args.root || process.cwd();
  const resolved = resolveWorkflow(workflowRoot, args["workflow-id"]);
  if (!resolved.state) {
    return {
      ok: true,
      message: "no active workflow; closeout check skipped",
      ...workflowRootInfo(workflowRoot),
      needs_closeout: false,
      skipped: true,
      reason: "no_active_workflow",
    };
  }
  const state = resolved.state;
  if (state.status === "completed" && state.closed_by_user_decision && state.closed_by_user_decision.action === "close-workflow") {
    return {
      ok: true,
      message: "workflow closed by recorded user instruction",
      ...workflowRootInfo(workflowRoot),
      workflow_id: state.workflow_id,
      workflow_status: state.status,
      needs_closeout: false,
      skipped: true,
      reason: "workflow_closed_by_user_instruction",
      user_decision: state.closed_by_user_decision,
      pending_quality_gates: [],
      quality_gate_tracking: state.quality_gate_tracking || null,
      available_skills: [],
      ai_required_actions: [],
    };
  }
  const session = activeStepSession(state);
  if (session) {
    return {
      ok: true,
      message: "active step session is pending",
      ...workflowRootInfo(workflowRoot),
      workflow_id: state.workflow_id,
      current_stage: state.current_stage,
      current_step_index: state.current_step_index,
      needs_closeout: true,
      pending_reason: "active_step_session",
      active_step_session: session,
      next_step: activeStepForSession(session),
      available_skills: availableSkills(session.stage || state.current_stage, workflowRoot),
      ai_required_actions: [
        "continue the active KFC step session before final user response",
        `use the active selected skill: ${session.selected_skill || session.skill || session.selected_worker}`,
        "if the skill needs more user input, ask the user instead of advancing the workflow",
        "only run complete after the selected skill produces a recordable output path and purpose",
      ],
    };
  }
  const pending = pendingQualityGateSteps(state);
  const firstPendingStepId = pending[0] || null;
  if (pending.length && args.prepare) {
    const previousStage = state.current_stage;
    const targetIndex = Math.max(0, stepIndexById(qualityGateStage, firstPendingStepId));
    state.current_stage = qualityGateStage;
    state.current_step_index = targetIndex;
    state.status = "active";
    state.stage_history = state.stage_history || [];
    if (previousStage !== qualityGateStage) {
      state.stage_history.push({
        stage: qualityGateStage,
        entered_at: nowIso(),
        reason: "code_change_quality_closeout",
        previous_stage: previousStage,
      });
    }
    state.quality_gate_tracking = {
      ...(state.quality_gate_tracking || {}),
      quality_gate_stage: qualityGateStage,
      pending_quality_gates: pending,
      closeout_prepared_at: nowIso(),
      updated_at: nowIso(),
    };
    state.updated_at = nowIso();
    writeWorkflowState(workflowRoot, state);
    upsertActiveWorkflow(workflowRoot, state, { makeDefault: true });
  }
  const nextStepDef = firstPendingStepId
    ? effectiveStepFor(qualityGateStage, getStage(qualityGateStage).default_steps[stepIndexById(qualityGateStage, firstPendingStepId)])
    : null;
  return {
    ok: true,
    message: pending.length ? "quality closeout is pending" : "no quality closeout pending",
    ...workflowRootInfo(workflowRoot),
    workflow_id: state.workflow_id,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    needs_closeout: pending.length > 0,
    quality_gate_stage: qualityGateStage,
    pending_quality_gates: pending,
    next_quality_gate_step: nextStepDef,
    quality_gate_tracking: state.quality_gate_tracking || null,
    available_skills: pending.length ? availableSkills(qualityGateStage, workflowRoot) : [],
    ai_required_actions: pending.length
      ? [
          "continue KFC quality closeout before final user response",
          "use the next_quality_gate_step default skill first",
          "after each quality gate output, run complete with --output-path",
          "do not create a git commit; hand off to the user after quality closeout",
        ]
      : [],
  };
}

function stepIdFromArgs(args) {
  return args.step || args["step-id"] || args.step_id;
}

function candidateWorkersFromArgs(args, fallbackDefaultWorker) {
  const explicit = parsePatterns(args["candidate-workers"] || args.candidates || args.workers);
  if (explicit.length) return explicit;
  return fallbackDefaultWorker ? [fallbackDefaultWorker] : [];
}

function stepPositionFromArgs(args) {
  if (args.before) return { before: args.before };
  if (args.after) return { after: args.after };
  return null;
}

function stepEntryFromArgs(args, mode) {
  const defaultWorker = args["default-worker"] || args.default_worker || args.worker || args.skill;
  const entry = {
    stage: args.stage,
    step_id: stepIdFromArgs(args),
  };
  if (args.title) entry.title = args.title;
  if (defaultWorker) entry.default_worker = defaultWorker;
  const candidates = candidateWorkersFromArgs(args, defaultWorker);
  if (candidates.length) entry.candidate_workers = candidates;
  if (args["output-purpose"] || args.output_purpose || args.purpose) {
    entry.output_purpose = args["output-purpose"] || args.output_purpose || args.purpose;
  }
  if (args.condition) entry.condition = args.condition;
  const position = stepPositionFromArgs(args);
  if (position) entry.position = position;
  if (mode === "move" && !position) {
    throw new Error("missing before/after target for steps move");
  }
  return entry;
}

function userStepRegistryWith(entry) {
  const registry = readUserStepRegistry();
  const next = {
    ...registry,
    steps: [...(registry.steps || [])],
  };
  const id = `${entry.stage}.${entry.step_id}`;
  const normalized = {
    ...entry,
    id,
    scope: "global",
    updated_at: nowIso(),
  };
  const index = next.steps.findIndex((item) => (item.id || `${item.stage}.${item.step_id}`) === id);
  if (index >= 0) {
    next.steps[index] = { ...next.steps[index], ...normalized };
  } else {
    next.steps.push({ ...normalized, created_at: nowIso() });
  }
  return next;
}

function effectiveStepFromRegistry(registry, stage, stepId) {
  const effective = readEffectiveStageSteps({ userRegistry: registry });
  const stageDef = effective.stages[stage] || null;
  const step = stageDef && (stageDef.default_steps || []).find((item) => item.step_id === stepId);
  return { effective, step: step || null };
}

function commandSteps(args) {
  const workflowRoot = args.root || process.cwd();
  const action = args._[1] || "list";
  if (action === "schema") {
    return {
      ok: true,
      command: "steps schema",
      ...workflowRootInfo(workflowRoot),
      ...stepRegistrySchema(),
    };
  }

  if (action === "list" || action === "catalog") {
    const effective = readStageSteps();
    const stage = args.stage;
    const validation = effective.validation || validateStepRegistry();
    if (stage) {
      const stageDef = effective.stages[stage];
      if (!stageDef) {
        return { ok: false, reason: "unknown_stage", stage, ...workflowRootInfo(workflowRoot), validation };
      }
      return {
        ok: true,
        command: "steps list",
        ...workflowRootInfo(workflowRoot),
        stage,
        next_stage: stageDef.next_stage,
        steps: stageDef.default_steps || [],
        validation,
      };
    }
    return {
      ok: true,
      command: "steps list",
      ...workflowRootInfo(workflowRoot),
      stages: effective.stages,
      validation,
    };
  }

  if (action === "validate") {
    const validation = validateStepRegistry();
    return {
      ok: validation.ok,
      command: "steps validate",
      ...workflowRootInfo(workflowRoot),
      validation,
    };
  }

  if (action === "add" || action === "preview-add" || action === "update" || action === "preview-update" || action === "move") {
    const mode = action.replace(/^preview-/, "");
    const entry = stepEntryFromArgs(args, mode);
    if (!entry.stage) throw new Error("missing stage");
    if (!entry.step_id) throw new Error("missing step");
    const stageDef = getStage(entry.stage);
    const systemStep = (stageDef.default_steps || []).find((step) => step.step_id === entry.step_id);
    if (mode === "add" && systemStep) {
      return { ok: false, reason: "step_already_exists_use_update", stage: entry.stage, step_id: entry.step_id, ...workflowRootInfo(workflowRoot) };
    }
    if (mode === "add") {
      for (const field of ["default_worker", "output_purpose"]) {
        if (!entry[field]) throw new Error(`missing ${field}`);
      }
    }
    const registry = userStepRegistryWith(entry);
    const validation = validateStepRegistry(registry);
    const { step } = effectiveStepFromRegistry(registry, entry.stage, entry.step_id);
    if (!validation.ok) {
      return {
        ok: false,
        reason: "step_registry_validation_failed",
        ...workflowRootInfo(workflowRoot),
        stage: entry.stage,
        step_id: entry.step_id,
        preview: { step },
        validation,
        applied: false,
      };
    }
    if (args.apply) {
      upsertStepRegistryEntry(entry);
    }
    return {
      ok: true,
      command: `steps ${mode}`,
      ...workflowRootInfo(workflowRoot),
      stage: entry.stage,
      step_id: entry.step_id,
      preview: { step },
      validation,
      applied: Boolean(args.apply),
    };
  }

  if (action === "reset") {
    const stage = args.stage;
    const stepId = stepIdFromArgs(args);
    if (!stage) throw new Error("missing stage");
    if (!stepId) throw new Error("missing step");
    const registry = removeStepRegistryEntry({ stage, step_id: stepId });
    const effective = readStageSteps();
    return {
      ok: true,
      command: "steps reset",
      ...workflowRootInfo(workflowRoot),
      stage,
      step_id: stepId,
      removed: registry.removed_count > 0,
      removed_count: registry.removed_count,
      effective_step: effective.stages[stage] && (effective.stages[stage].default_steps || []).find((step) => step.step_id === stepId) || null,
    };
  }

  if (action === "remove") {
    const stage = args.stage;
    const stepId = stepIdFromArgs(args);
    if (!stage) throw new Error("missing stage");
    if (!stepId) throw new Error("missing step");
    const effective = readStageSteps();
    const step = effective.stages[stage] && (effective.stages[stage].default_steps || []).find((item) => item.step_id === stepId);
    if (!step) {
      return { ok: false, reason: "unknown_step", ...workflowRootInfo(workflowRoot), stage, step_id: stepId };
    }
    if (step.source !== "user_added") {
      return { ok: false, reason: "cannot_remove_system_step", ...workflowRootInfo(workflowRoot), stage, step_id: stepId, source: step.source };
    }
    const registry = removeStepRegistryEntry({ stage, step_id: stepId });
    return {
      ok: true,
      command: "steps remove",
      ...workflowRootInfo(workflowRoot),
      stage,
      step_id: stepId,
      removed: registry.removed_count > 0,
      removed_count: registry.removed_count,
    };
  }

  throw new Error(`unknown steps action: ${action}`);
}

function commandWorkerMutation(args, action) {
  if (args.scope === "package") {
    if (action !== "remove") throw new Error("package scope only supports removal");
    return require("./package-workers").removePackageSkill(args);
  }
  const workflowRoot = args.root || process.cwd();
  const stage = args.stage;
  const stepId = args.step || args["step-id"];
  const skill = args.skill || args.worker || args._[1];
  if (!skill) throw new Error("missing skill");
  if (!stage) throw new Error("missing stage; dynamic skill registration is global and must target a stage");
  if (!stepId) throw new Error("missing step; dynamic skill registration must target a stage substep");
  const stageDef = getStage(stage);
  const stepExists = (stageDef.default_steps || []).some((step) => step.step_id === stepId);
  if (!stepExists) throw new Error(`unknown step for stage ${stage}: ${stepId}`);
  let registry;
  if (action === "add") {
    registry = upsertSkillRegistryEntry({
      stage,
      step_id: stepId,
      skill,
      summary: args.summary || "",
      strategy: args.strategy || args.hint || args["call-hint"] || "",
      patterns: parsePatterns(args.patterns || args.pattern),
    });
    if (args.default || args["set-default"]) {
      registry = upsertDefaultSkill({
        stage,
        step_id: stepId,
        skill,
        reason: args.reason || args.strategy || args.hint || args["call-hint"] || "user selected this skill as default",
      });
    }
  } else {
    registry = removeSkillRegistryEntry({
      stage,
      step_id: stepId,
      skill,
    });
    registry = removeDefaultSkill({
      stage,
      step_id: stepId,
      skill,
    });
  }
  const entries = registry.entries.filter((entry) => entry.stage === stage && entry.step_id === stepId);
  const defaultSkill = registry.default_skills.find((entry) => entry.stage === stage && entry.step_id === stepId) || null;
  return {
    ok: true,
    ...workflowRootInfo(workflowRoot),
    root_diagnostics: rootDiagnostics(workflowRoot),
    message: action === "add" ? "skill registered" : "skill unregistered",
    scope: "global",
    stage,
    step_id: stepId,
    skill,
    worker: skill,
    registered_skills: entries,
    default_skill: defaultSkill,
    effective_step: effectiveStepFor(stage, (stageDef.default_steps || []).find((step) => step.step_id === stepId)),
    registry_path: userSkillRegistryPath(),
    builtin_registry_path: builtinSkillRegistryPath(),
  };
}

function commandDefaultSkillMutation(args, action) {
  const workflowRoot = args.root || process.cwd();
  const stage = args.stage;
  const stepId = args.step || args["step-id"];
  const skill = args.skill || args.worker || args._[1];
  if (!stage) throw new Error("missing stage; default skill must target a stage");
  if (!stepId) throw new Error("missing step; default skill must target a stage substep");
  const stageDef = getStage(stage);
  const step = (stageDef.default_steps || []).find((item) => item.step_id === stepId);
  if (!step) throw new Error(`unknown step for stage ${stage}: ${stepId}`);
  let registry;
  if (action === "set") {
    if (!skill) throw new Error("missing skill");
    const allowedSkills = allowedDefaultSkillsForStep(stage, step);
    if (!allowedSkills.includes(skill)) {
      throw new Error(`skill ${skill} is not registered or listed as a candidate for ${stage}.${stepId}; run add-skill first or choose one of: ${allowedSkills.join(", ")}`);
    }
    registry = upsertDefaultSkill({
      stage,
      step_id: stepId,
      skill,
      reason: args.reason || "",
    });
  } else {
    registry = removeDefaultSkill({
      stage,
      step_id: stepId,
      skill,
    });
  }
  const defaultSkill = registry.default_skills.find((entry) => entry.stage === stage && entry.step_id === stepId) || null;
  return {
    ok: true,
    ...workflowRootInfo(workflowRoot),
    root_diagnostics: rootDiagnostics(workflowRoot),
    message: action === "set" ? "default skill set" : "default skill removed",
    scope: "global",
    stage,
    step_id: stepId,
    skill: skill || null,
    default_skill: defaultSkill,
    allowed_default_skills: allowedDefaultSkillsForStep(stage, step),
    effective_step: effectiveStepFor(stage, step),
    registry_path: userSkillRegistryPath(),
    builtin_registry_path: builtinSkillRegistryPath(),
  };
}

function commandContext(args) {
  const workflowRoot = args.root || process.cwd();
  return {
    ok: true,
    state_root: kfcStateRoot(workflowRoot),
    project_context_entries: projectContextEntries(workflowRoot, {
      workflowId: args["workflow-id"],
      stage: args.stage,
      skill: args.skill,
      material: args.material,
    }),
  };
}

function commandContextAdd(args) {
  const workflowRoot = args.root || process.cwd();
  const existing = readProjectContext(workflowRoot).entries.find((entry) => entry.id === args.id) || {};
  const entry = normalizeContextEntry(args, existing);
  upsertProjectContextEntry(workflowRoot, entry);
  return {
    ok: true,
    message: "project context entry saved",
    state_root: kfcStateRoot(workflowRoot),
    project_context_entry: entry,
  };
}

function commandContextRemove(args) {
  const workflowRoot = args.root || process.cwd();
  const id = args.id || args._[1];
  const context = removeProjectContextEntry(workflowRoot, id);
  return {
    ok: true,
    message: "project context entry removed",
    state_root: kfcStateRoot(workflowRoot),
    removed_id: id,
    project_context_entries: context.entries,
  };
}

function commandDependencies(args) {
  const roots = localSkillRoots(args);
  const requiredSkills = catalogRequiredSkills();
  const missing = requiredSkills.filter((name) => !skillExists(name, roots));
  return {
    ok: missing.length === 0, checked_roots: roots, dependency_packages: [],
    required_skills: requiredSkills, missing_skills: missing,
    install_required: missing.length > 0, install_attempted: false,
    install_command: missing.length ? dependencyInstallCommand() : null,
  };
}

function runHookHelper(command, args) {
  if (!fs.existsSync(hookHelperScript)) {
    return {
      ok: false,
      error: "kfc hook helper script not found",
      hook_helper_script: hookHelperScript,
    };
  }
  const helperArgs = [hookHelperScript, command];
  if (args.root) helperArgs.push("--root", args.root);
  if (args.agent) helperArgs.push("--agent", args.agent);
  try {
    const stdout = execFileSync(process.execPath, helperArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout || "{}");
  } catch (error) {
    return {
      ok: false,
      hook_helper_script: hookHelperScript,
      command,
      status: typeof error.status === "number" ? error.status : null,
      stdout: error.stdout ? String(error.stdout).trim() : "",
      stderr: error.stderr ? String(error.stderr).trim() : "",
      error: error.message || String(error),
    };
  }
}

function commandHooksCheck(args) {
  const workflowRoot = args.root || process.cwd();
  const result = runHookHelper("check", { ...args, root: workflowRoot });
  return {
    ...result,
    workflow_root: path.resolve(workflowRoot),
    hook_helper_script: hookHelperScript,
    ai_required_actions: [
      "skip agents whose installed=false",
      "if installed agents are missing KFC local rules, tell the user which files would be changed",
      "for Kiro, use global steering at ~/.kiro/steering/kfc-routing.md instead of project hooks",
      "ask the user before running hooks-install",
      "if the user asks to turn hooks off, remove only KFC-owned hook entries or Kiro steering",
      "do not block KFC routing when the user declines hook installation",
    ],
  };
}

function commandHooksInstall(args) {
  const workflowRoot = args.root || process.cwd();
  if (!args.agent) {
    throw new Error("missing agent; use --agent codex, --agent claude-code, --agent kiro, or --agent all");
  }
  return {
    ...runHookHelper("install", { ...args, root: workflowRoot }),
    workflow_root: path.resolve(workflowRoot),
    hook_helper_script: hookHelperScript,
  };
}

function commandHooksRemove(args) {
  const workflowRoot = args.root || process.cwd();
  if (!args.agent) {
    throw new Error("missing agent; use --agent codex, --agent claude-code, --agent kiro, or --agent all");
  }
  return {
    ...runHookHelper("remove", { ...args, root: workflowRoot }),
    workflow_root: path.resolve(workflowRoot),
    hook_helper_script: hookHelperScript,
  };
}

function commandDoctor(args) {
  const workflowRoot = args.root || process.cwd();
  const before = stateStability(workflowRoot);
  const fixed = [];
  if (args.fix) {
    for (const issue of before.issues) {
      if (issue.code === "workflow_state_tmp_exists" && issue.path && fs.existsSync(issue.path)) {
        fs.unlinkSync(issue.path);
        fixed.push({ code: issue.code, action: "removed_tmp_file", path: issue.path });
      }
      if (issue.code === "empty_workflow_dir" && issue.workflow_id) {
        const dir = path.join(kfcStateRoot(workflowRoot), "workflows", issue.workflow_id);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
          fixed.push({ code: issue.code, action: "removed_empty_workflow_dir", workflow_id: issue.workflow_id });
        }
      }
    }
    const healthyIds = new Set(before.healthy_workflows.map((item) => item.workflow_id));
    const activePath = activeWorkflowsPath(workflowRoot);
    let active = { version: 1, default_workflow_id: null, workflows: [] };
    if (fs.existsSync(activePath)) {
      const parsed = readJsonSafe(activePath);
      if (parsed.ok) {
        active = parsed.value || active;
      } else {
        const backupPath = `${activePath}.broken-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
        fs.renameSync(activePath, backupPath);
        fixed.push({ code: "active_workflows_json_invalid", action: "moved_invalid_active_file_aside", backup_path: backupPath });
      }
    }
    active.version = active.version || 1;
    active.workflows = Array.isArray(active.workflows) ? active.workflows : [];
    const originalWorkflowCount = active.workflows.length;
    active.workflows = active.workflows.filter((item) => item && item.workflow_id && healthyIds.has(item.workflow_id));
    if (active.workflows.length !== originalWorkflowCount) {
      fixed.push({ code: "active_points_to_missing_or_broken_workflow", action: "removed_broken_active_refs" });
    }
    if (!active.default_workflow_id || !healthyIds.has(active.default_workflow_id)) {
      if (active.workflows.length === 1) {
        active.default_workflow_id = active.workflows[0].workflow_id;
        fixed.push({ code: "default_workflow_missing_or_broken", action: "set_unique_healthy_workflow_as_default", workflow_id: active.default_workflow_id });
      } else if (active.workflows.length === 0) {
        active.default_workflow_id = null;
        fixed.push({ code: "default_workflow_missing_or_broken", action: "cleared_default_workflow" });
      }
    }
    if (fixed.length || fs.existsSync(activePath)) {
      writeActiveWorkflows(workflowRoot, active);
    }
  }
  const after = args.fix ? stateStability(workflowRoot) : before;
  const hasActiveSessions = after.healthy_workflows.filter((item) => item.active_step_session);
  const pendingCloseout = after.healthy_workflows.filter((item) => item.pending_closeout);
  const recommendedActions = [];
  if (!after.stable) {
    recommendedActions.push("review doctor issues before retrying the original KFC command");
    if (!args.fix) recommendedActions.push("run doctor again with --fix for safe automatic repairs");
  } else {
    recommendedActions.push("retry the original KFC command");
  }
  if (hasActiveSessions.length) {
    recommendedActions.push("continue active_step_session before routing or starting another step");
  }
  if (pendingCloseout.length) {
    recommendedActions.push("run closeout-check and finish pending quality gates before final handoff");
  }
  return {
    ok: after.stable,
    message: after.stable ? "KFC state is stable" : "KFC state still has issues",
    ...workflowRootInfo(workflowRoot),
    fixed,
    state_stability: after,
    active_step_sessions: hasActiveSessions,
    pending_closeout_workflows: pendingCloseout,
    next_required_action: after.stable ? "retry_original_command" : "inspect_or_fix_kfc_state",
    ai_required_actions: recommendedActions,
  };
}

function help() {
  return [
    "kfc route runner",
    "",
    "This route runner is distributed inside kfc-flow-router/scripts.",
    "It is called directly by kfc/scripts/kfc.js, not through a global CLI.",
    "",
    "Commands:",
    "  init --root <dir> [--workflow-id <id>] [--title <title>] [--stage <stage>] [--material <text>]",
    "  current --root <dir> [--workflow-id <id>]",
    "  catalog [--stage <stage>]",
    "  route --root <dir> --material <text> [--workflow-id <id>]",
    "  continue --root <dir> [--workflow-id <id>] [--skill <skill-name>]",
    "  complete --root <dir> [--workflow-id <id>] --output-path <path> [--purpose <text>]",
    "  context --root <dir> [--workflow-id <id>] [--stage <stage>] [--skill <skill-name>] [--material <text>]",
    "  context-add --root <dir> --id <id> --title <title> --ref <path-or-url> [--type <type>] [--stage <stage>] [--skill <skill-name>]",
    "  context-remove --root <dir> --id <id>",
    "  steps schema",
    "  steps list [--stage <stage>]",
    "  steps validate",
    "  steps add --stage <stage> --step <step-id> --default-worker <skill> --output-purpose <text> [--candidate-workers <list>] [--before <step>|--after <step>] [--apply]",
    "  steps update --stage <stage> --step <step-id> [--default-worker <skill>] [--candidate-workers <list>] [--output-purpose <text>] [--before <step>|--after <step>] [--apply]",
    "  steps move --stage <stage> --step <step-id> (--before <step>|--after <step>) [--apply]",
    "  steps reset --stage <stage> --step <step-id>",
    "  steps remove --stage <stage> --step <step-id>",
    "  add-skill --root <dir> --stage <stage> --step <step-id> --skill <skill-name> [--strategy <text>] [--patterns <list>] [--default]",
    "  remove-skill --root <dir> --stage <stage> --step <step-id> --skill <skill-name>",
    "  remove-skill --scope package --stage <stage> --step <step> --skill <skill> --remove-step [--apply --plan <hash>]",
    "  set-default-skill --root <dir> --stage <stage> --step <step-id> --skill <skill-name> [--reason <text>]",
    "  remove-default-skill --root <dir> --stage <stage> --step <step-id> [--skill <skill-name>]",
    "  dependencies [--skills-root <path-list>]",
    "  mark-code-change --root <dir> [--workflow-id <id>] [--event <event>] [--tool-name <name>]",
    "  record-user-decision --root <dir> [--workflow-id <id>] --action <manual-pass|skip-gate> --step <quality-step-id> --reason <user-instruction>",
    "  record-user-decision --root <dir> [--workflow-id <id>] --action close-workflow --reason <user-instruction>",
    "  closeout-check --root <dir> [--workflow-id <id>] [--prepare]",
    "  doctor --root <dir> [--fix]",
    "  hooks-check --root <dir>",
    "  hooks-install --root <dir> --agent <codex|claude-code|kiro|all>",
    "  hooks-remove --root <dir> --agent <codex|claude-code|kiro|all>",
    "  update",
    "  update-commands",
    "  dependency-command",
    "",
    `router_root=${routerRoot}`,
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  try {
    if (args.help || !command) {
      console.log(help());
      return;
    }
    if (command === "update-commands") {
      console.log(updateCommands().join("\n"));
      return;
    }
    if (command === "dependency-command") {
      console.log(dependencyInstallCommand());
      return;
    }

    const handlers = {
      init: commandInit,
      current: commandCurrent,
      catalog: commandCatalog,
      route: commandRoute,
      continue: commandContinue,
      complete: commandComplete,
      context: commandContext,
      "context-add": commandContextAdd,
      "context-remove": commandContextRemove,
      steps: commandSteps,
      "add-skill": (parsed) => commandWorkerMutation(parsed, "add"),
      "remove-skill": (parsed) => commandWorkerMutation(parsed, "remove"),
      "add-worker": (parsed) => commandWorkerMutation(parsed, "add"),
      "remove-worker": (parsed) => commandWorkerMutation(parsed, "remove"),
      "set-default-skill": (parsed) => commandDefaultSkillMutation(parsed, "set"),
      "remove-default-skill": (parsed) => commandDefaultSkillMutation(parsed, "remove"),
      dependencies: commandDependencies,
      "mark-code-change": commandMarkCodeChange,
      "record-user-decision": commandRecordUserDecision,
      "closeout-check": commandCloseoutCheck,
      doctor: commandDoctor,
      "hooks-check": commandHooksCheck,
      "hooks-install": commandHooksInstall,
      "hooks-remove": commandHooksRemove,
      update: commandUpdate,
    };
    if (!handlers[command]) {
      throw new Error(`unknown command: ${command}`);
    }
    const guardedCommands = new Set(["current", "route", "continue", "complete", "record-user-decision", "closeout-check"]);
    if (guardedCommands.has(command)) {
      const stability = stateStability(args.root || process.cwd());
      if (!stability.stable) {
        output(unstableStateResponse(command, args, stability), args);
        return;
      }
    }
    output(handlers[command](args), args);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

main();
