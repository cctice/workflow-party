const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_VERSION = 1;

function kfcStateRoot(workflowRoot) {
  return path.join(path.resolve(workflowRoot), ".kfc");
}

function workflowStatePath(workflowRoot, workflowId) {
  return path.join(kfcStateRoot(workflowRoot), "workflows", workflowId, "workflow-state.json");
}

function activeWorkflowsPath(workflowRoot) {
  return path.join(kfcStateRoot(workflowRoot), "active-workflows.json");
}

function projectContextPath(workflowRoot) {
  return path.join(kfcStateRoot(workflowRoot), "project-context.json");
}

function builtinSkillRegistryPath() {
  return path.resolve(__dirname, "..", "references", "builtin-skill-registry.json");
}

function userSkillRegistryPath() {
  return path.join(process.env.KFC_CONFIG_HOME || path.join(os.homedir(), ".config", "kfc-plugin"), "skill-registry.json");
}

function userStepRegistryPath() {
  return path.join(process.env.KFC_CONFIG_HOME || path.join(os.homedir(), ".config", "kfc-plugin"), "step-registry.json");
}

function skillRegistryPath() {
  return userSkillRegistryPath();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return readJson(filePath);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value || "workflow")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workflow";
}

function createWorkflowId(title) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${slugify(title)}-${stamp}`;
}

function emptyActiveWorkflows() {
  return {
    version: STATE_VERSION,
    default_workflow_id: null,
    workflows: [],
  };
}

function emptyProjectContext() {
  return {
    version: STATE_VERSION,
    entries: [],
  };
}

function emptySkillRegistry() {
  return {
    version: STATE_VERSION,
    entries: [],
    default_skills: [],
  };
}

function emptyStepRegistry() {
  return {
    version: STATE_VERSION,
    steps: [],
  };
}

function readActiveWorkflows(workflowRoot) {
  const active = readJsonIfExists(activeWorkflowsPath(workflowRoot), emptyActiveWorkflows());
  active.version = active.version || STATE_VERSION;
  active.workflows = Array.isArray(active.workflows) ? active.workflows : [];
  return active;
}

function writeActiveWorkflows(workflowRoot, active) {
  writeJsonAtomic(activeWorkflowsPath(workflowRoot), active);
}

function readProjectContext(workflowRoot) {
  const context = readJsonIfExists(projectContextPath(workflowRoot), emptyProjectContext());
  context.version = context.version || STATE_VERSION;
  context.entries = Array.isArray(context.entries) ? context.entries : [];
  return context;
}

function writeProjectContext(workflowRoot, context) {
  const next = context || emptyProjectContext();
  next.version = next.version || STATE_VERSION;
  next.entries = Array.isArray(next.entries) ? next.entries : [];
  writeJson(projectContextPath(workflowRoot), next);
  return next;
}

function upsertProjectContextEntry(workflowRoot, entry) {
  if (!entry || !entry.id) {
    throw new Error("project context entry must include id");
  }
  const context = readProjectContext(workflowRoot);
  const index = context.entries.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    context.entries[index] = { ...context.entries[index], ...entry };
  } else {
    context.entries.push(entry);
  }
  return writeProjectContext(workflowRoot, context);
}

function removeProjectContextEntry(workflowRoot, id) {
  if (!id) {
    throw new Error("missing project context id");
  }
  const context = readProjectContext(workflowRoot);
  context.entries = context.entries.filter((item) => item.id !== id);
  return writeProjectContext(workflowRoot, context);
}

function normalizeSkillRegistry(registry) {
  registry.version = registry.version || STATE_VERSION;
  registry.entries = Array.isArray(registry.entries) ? registry.entries : [];
  registry.default_skills = Array.isArray(registry.default_skills) ? registry.default_skills : [];
  return registry;
}

function normalizeStepRegistry(registry) {
  registry.version = registry.version || STATE_VERSION;
  registry.steps = Array.isArray(registry.steps) ? registry.steps : [];
  return registry;
}

function readUserSkillRegistry() {
  return normalizeSkillRegistry(readJsonIfExists(userSkillRegistryPath(), emptySkillRegistry()));
}

function readUserStepRegistry() {
  return normalizeStepRegistry(readJsonIfExists(userStepRegistryPath(), emptyStepRegistry()));
}

function readBuiltinSkillRegistry() {
  return normalizeSkillRegistry(readJsonIfExists(builtinSkillRegistryPath(), emptySkillRegistry()));
}

function readSkillRegistry() {
  const builtin = readBuiltinSkillRegistry();
  const user = readUserSkillRegistry();
  const entriesById = new Map();
  for (const entry of builtin.entries) {
    entriesById.set(entry.id || skillRegistryEntryId(entry), {
      ...entry,
      id: entry.id || skillRegistryEntryId(entry),
      registry_source: "builtin",
    });
  }
  for (const entry of user.entries) {
    entriesById.set(entry.id || skillRegistryEntryId(entry), {
      ...entry,
      id: entry.id || skillRegistryEntryId(entry),
      registry_source: "user",
    });
  }
  return {
    version: STATE_VERSION,
    entries: Array.from(entriesById.values()),
    default_skills: user.default_skills.map((item) => ({
      ...item,
      id: item.id || defaultSkillId(item),
      registry_source: "user",
    })),
  };
}

function writeSkillRegistry(registry) {
  const next = registry || emptySkillRegistry();
  next.version = next.version || STATE_VERSION;
  next.entries = Array.isArray(next.entries) ? next.entries : [];
  next.default_skills = Array.isArray(next.default_skills) ? next.default_skills : [];
  writeJson(userSkillRegistryPath(), next);
  return next;
}

function writeStepRegistry(registry) {
  const next = registry || emptyStepRegistry();
  next.version = next.version || STATE_VERSION;
  next.steps = Array.isArray(next.steps) ? next.steps : [];
  writeJsonAtomic(userStepRegistryPath(), next);
  return next;
}

function skillRegistryEntryId(entry) {
  const stage = entry.stage || "stage";
  const step = entry.step_id || "step";
  const skill = entry.skill || "skill";
  return `${stage}.${step}.${skill}`;
}

function stepRegistryEntryId(entry) {
  const stage = entry.stage || "stage";
  const step = entry.step_id || "step";
  return `${stage}.${step}`;
}

function defaultSkillId(entry) {
  const stage = entry.stage || "stage";
  const step = entry.step_id || "step";
  return `${stage}.${step}`;
}

function upsertSkillRegistryEntry(entry) {
  if (!entry || !entry.skill) {
    throw new Error("skill registry entry must include skill");
  }
  if (!entry.stage) {
    throw new Error("skill registry entry must include stage");
  }
  if (!entry.step_id) {
    throw new Error("skill registry entry must include step_id");
  }
  const registry = readUserSkillRegistry();
  const now = nowIso();
  const normalized = {
    ...entry,
    id: entry.id || skillRegistryEntryId(entry),
    scope: "global",
    updated_at: now,
  };
  const index = registry.entries.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    registry.entries[index] = { ...registry.entries[index], ...normalized };
  } else {
    registry.entries.push({ ...normalized, created_at: now });
  }
  return writeSkillRegistry(registry);
}

function upsertDefaultSkill(entry) {
  if (!entry || !entry.skill) {
    throw new Error("default skill entry must include skill");
  }
  if (!entry.stage) {
    throw new Error("default skill entry must include stage");
  }
  if (!entry.step_id) {
    throw new Error("default skill entry must include step_id");
  }
  const registry = readUserSkillRegistry();
  const now = nowIso();
  const normalized = {
    ...entry,
    id: entry.id || defaultSkillId(entry),
    scope: "global",
    updated_at: now,
  };
  const index = registry.default_skills.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    registry.default_skills[index] = { ...registry.default_skills[index], ...normalized };
  } else {
    registry.default_skills.push({ ...normalized, created_at: now });
  }
  return writeSkillRegistry(registry);
}

function removeDefaultSkill(filters) {
  const registry = readUserSkillRegistry();
  const stage = filters.stage;
  const stepId = filters.step_id;
  const skill = filters.skill;
  registry.default_skills = registry.default_skills.filter((entry) => {
    if (skill && entry.skill !== skill) return true;
    if (stage && entry.stage !== stage) return true;
    if (stepId && entry.step_id !== stepId) return true;
    return false;
  });
  return writeSkillRegistry(registry);
}

function removeSkillRegistryEntry(filters) {
  const registry = readUserSkillRegistry();
  const stage = filters.stage;
  const stepId = filters.step_id;
  const skill = filters.skill;
  registry.entries = registry.entries.filter((entry) => {
    if (skill && entry.skill !== skill) return true;
    if (stage && entry.stage !== stage) return true;
    if (stepId && entry.step_id !== stepId) return true;
    return false;
  });
  return writeSkillRegistry(registry);
}

function upsertStepRegistryEntry(entry) {
  if (!entry || !entry.stage) {
    throw new Error("step registry entry must include stage");
  }
  if (!entry.step_id) {
    throw new Error("step registry entry must include step_id");
  }
  const registry = readUserStepRegistry();
  const now = nowIso();
  const normalized = {
    ...entry,
    id: entry.id || stepRegistryEntryId(entry),
    scope: "global",
    updated_at: now,
  };
  const index = registry.steps.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    registry.steps[index] = { ...registry.steps[index], ...normalized };
  } else {
    registry.steps.push({ ...normalized, created_at: now });
  }
  return writeStepRegistry(registry);
}

function removeStepRegistryEntry(filters) {
  const registry = readUserStepRegistry();
  const stage = filters.stage;
  const stepId = filters.step_id;
  const before = registry.steps.length;
  registry.steps = registry.steps.filter((entry) => {
    if (stage && entry.stage !== stage) return true;
    if (stepId && entry.step_id !== stepId) return true;
    return false;
  });
  const next = writeStepRegistry(registry);
  next.removed_count = before - next.steps.length;
  return next;
}

function readWorkflowState(workflowRoot, workflowId) {
  return readJsonIfExists(workflowStatePath(workflowRoot, workflowId), null);
}

function writeWorkflowState(workflowRoot, state) {
  if (!state || !state.workflow_id) {
    throw new Error("workflow state must include workflow_id");
  }
  writeJsonAtomic(workflowStatePath(workflowRoot, state.workflow_id), state);
}

function workflowSummary(state) {
  return {
    workflow_id: state.workflow_id,
    title: state.title,
    status: state.status,
    current_stage: state.current_stage,
    current_step_index: state.current_step_index,
    updated_at: state.updated_at,
  };
}

function upsertActiveWorkflow(workflowRoot, state, options = {}) {
  const active = readActiveWorkflows(workflowRoot);
  const summary = workflowSummary(state);
  const index = active.workflows.findIndex((item) => item.workflow_id === state.workflow_id);
  if (index >= 0) {
    active.workflows[index] = { ...active.workflows[index], ...summary };
  } else {
    active.workflows.push(summary);
  }
  if (options.makeDefault || !active.default_workflow_id) {
    active.default_workflow_id = state.workflow_id;
  }
  writeActiveWorkflows(workflowRoot, active);
  return active;
}

function createWorkflowState({ workflowId, title, stage, material }) {
  const id = workflowId || createWorkflowId(title || stage);
  const createdAt = nowIso();
  return {
    version: STATE_VERSION,
    workflow_id: id,
    title: title || id,
    status: "active",
    current_stage: stage || "requirement",
    current_step_index: 0,
    selected_workers: [],
    outputs: [],
    materials: material ? [{ material, recorded_at: createdAt }] : [],
    stage_history: [
      {
        stage: stage || "requirement",
        entered_at: createdAt,
        reason: material ? "material_routing" : "init",
      },
    ],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function resolveWorkflow(workflowRoot, workflowId) {
  const active = readActiveWorkflows(workflowRoot);
  const resolvedId = workflowId || active.default_workflow_id;
  if (!resolvedId) {
    return { active, workflowId: null, state: null };
  }
  return {
    active,
    workflowId: resolvedId,
    state: readWorkflowState(workflowRoot, resolvedId),
  };
}

module.exports = {
  STATE_VERSION,
  kfcStateRoot,
  activeWorkflowsPath,
  workflowStatePath,
  projectContextPath,
  skillRegistryPath,
  builtinSkillRegistryPath,
  userSkillRegistryPath,
  userStepRegistryPath,
  readJson,
  readJsonIfExists,
  writeJson,
  writeJsonAtomic,
  nowIso,
  createWorkflowId,
  readActiveWorkflows,
  writeActiveWorkflows,
  readProjectContext,
  writeProjectContext,
  upsertProjectContextEntry,
  removeProjectContextEntry,
  readSkillRegistry,
  readBuiltinSkillRegistry,
  readUserSkillRegistry,
  writeSkillRegistry,
  readUserStepRegistry,
  writeStepRegistry,
  upsertSkillRegistryEntry,
  removeSkillRegistryEntry,
  upsertStepRegistryEntry,
  removeStepRegistryEntry,
  upsertDefaultSkill,
  removeDefaultSkill,
  readWorkflowState,
  writeWorkflowState,
  upsertActiveWorkflow,
  createWorkflowState,
  resolveWorkflow,
};
