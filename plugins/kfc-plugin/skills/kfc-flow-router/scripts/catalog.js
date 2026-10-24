const fs = require("fs");
const path = require("path");
const {
  readUserStepRegistry,
  userStepRegistryPath,
} = require("./state");

const STEP_META_FIELDS = new Set([
  "id",
  "scope",
  "stage",
  "step_id",
  "position",
  "before",
  "after",
  "created_at",
  "updated_at",
]);

function referencePath(fileName) {
  return path.resolve(__dirname, "..", "references", fileName);
}

function readTextCatalog(fileName) {
  return fs.readFileSync(referencePath(fileName), "utf8");
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.replace(/^["']|["']$/g, "");
}

function readSystemStageSteps() {
  const text = readTextCatalog("stage-steps.yaml");
  const lines = text.split(/\r?\n/);
  const stages = {};
  let currentStage = null;
  let currentStep = null;
  let currentList = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const stageMatch = line.match(/^  ([a-z0-9-]+):$/);
    if (stageMatch) {
      currentStage = stageMatch[1];
      stages[currentStage] = { stage_id: currentStage, default_steps: [] };
      currentStep = null;
      currentList = null;
      continue;
    }
    if (!currentStage) continue;

    const nextMatch = line.match(/^    next_stage:\s*(.+)$/);
    if (nextMatch) {
      stages[currentStage].next_stage = parseScalar(nextMatch[1]);
      continue;
    }

    if (/^    default_steps:\s*$/.test(line)) {
      currentList = "default_steps";
      continue;
    }

    const stepMatch = line.match(/^      - step_id:\s*(.+)$/);
    if (stepMatch) {
      currentStep = { step_id: parseScalar(stepMatch[1]) };
      stages[currentStage].default_steps.push(currentStep);
      currentList = null;
      continue;
    }

    if (!currentStep) continue;

    const stepField = line.match(/^        ([a-z_]+):\s*(.*)$/);
    if (stepField) {
      const key = stepField[1];
      const value = stepField[2];
      if (value === "") {
        currentStep[key] = [];
        currentList = key;
      } else {
        currentStep[key] = parseScalar(value);
        currentList = null;
      }
      continue;
    }

    const listItem = line.match(/^          -\s*(.+)$/);
    if (listItem && currentList && Array.isArray(currentStep[currentList])) {
      currentStep[currentList].push(parseScalar(listItem[1]));
    }
  }

  return { stages };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stepKey(stage, stepId) {
  return `${stage}.${stepId}`;
}

function stepPosition(entry) {
  const position = entry.position && typeof entry.position === "object" ? entry.position : {};
  return {
    before: entry.before || position.before || null,
    after: entry.after || position.after || null,
  };
}

function insertStep(steps, step, position) {
  const next = steps.filter((item) => item.step_id !== step.step_id);
  const before = position && position.before;
  const after = position && position.after;
  if (before) {
    const index = next.findIndex((item) => item.step_id === before);
    if (index >= 0) {
      next.splice(index, 0, step);
      return next;
    }
  }
  if (after) {
    const index = next.findIndex((item) => item.step_id === after);
    if (index >= 0) {
      next.splice(index + 1, 0, step);
      return next;
    }
  }
  next.push(step);
  return next;
}

function overriddenFields(systemStep, userStep) {
  if (!systemStep) return [];
  return Object.keys(userStep)
    .filter((field) => !STEP_META_FIELDS.has(field))
    .filter((field) => JSON.stringify(systemStep[field]) !== JSON.stringify(userStep[field]))
    .sort();
}

function normalizeSystemStep(step) {
  return {
    ...step,
    source: "system",
    order_source: "system",
    overridden_fields: [],
    missing_skills: [],
  };
}

function mergeStep(systemStep, userStep) {
  const fields = overriddenFields(systemStep, userStep);
  const merged = {
    ...systemStep,
    ...userStep,
    source: "user_override",
    order_source: stepPosition(userStep).before || stepPosition(userStep).after ? "user" : "system",
    overridden_fields: fields,
    system_step: {
      default_worker: systemStep.default_worker || null,
      candidate_workers: systemStep.candidate_workers || [],
      output_purpose: systemStep.output_purpose || null,
    },
    missing_skills: [],
  };
  delete merged.stage;
  delete merged.position;
  delete merged.before;
  delete merged.after;
  return merged;
}

function userAddedStep(userStep) {
  const step = {
    ...userStep,
    source: "user_added",
    order_source: "user",
    overridden_fields: [],
    missing_skills: [],
  };
  delete step.stage;
  delete step.position;
  delete step.before;
  delete step.after;
  return step;
}

function validateStepRegistry(registry = readUserStepRegistry(), system = readSystemStageSteps()) {
  const errors = [];
  const warnings = [];
  const stages = system.stages || {};
  const seen = new Set();
  for (const entry of registry.steps || []) {
    const stage = entry.stage;
    const stepId = entry.step_id;
    if (!stage) errors.push({ code: "missing_stage", entry });
    if (!stepId) errors.push({ code: "missing_step_id", entry });
    if (stage && !stages[stage]) {
      errors.push({ code: "unknown_stage", stage, step_id: stepId });
      continue;
    }
    if (!stage || !stepId) continue;
    const key = stepKey(stage, stepId);
    if (seen.has(key)) {
      errors.push({ code: "duplicate_user_step_entry", stage, step_id: stepId });
    }
    seen.add(key);
    const systemStep = (stages[stage].default_steps || []).find((step) => step.step_id === stepId);
    if (!systemStep) {
      for (const field of ["default_worker", "output_purpose"]) {
        if (!entry[field]) errors.push({ code: `missing_${field}`, stage, step_id: stepId });
      }
    }
    const position = stepPosition(entry);
    for (const [field, target] of Object.entries(position)) {
      if (!target) continue;
      const exists = (stages[stage].default_steps || []).some((step) => step.step_id === target)
        || (registry.steps || []).some((step) => step.stage === stage && step.step_id === target);
      if (!exists) errors.push({ code: `unknown_${field}_target`, stage, step_id: stepId, target });
      if (target === stepId) errors.push({ code: "step_cannot_position_relative_to_itself", stage, step_id: stepId });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function readEffectiveStageSteps(options = {}) {
  const system = cloneJson(options.system || readSystemStageSteps());
  const registry = options.userRegistry || readUserStepRegistry();
  const validation = validateStepRegistry(registry, system);
  const stages = system.stages || {};

  for (const stage of Object.values(stages)) {
    stage.default_steps = (stage.default_steps || []).map(normalizeSystemStep);
  }

  for (const entry of registry.steps || []) {
    const stage = stages[entry.stage];
    if (!stage) continue;
    const steps = stage.default_steps || [];
    const systemStep = steps.find((step) => step.step_id === entry.step_id && step.source === "system");
    const existingStep = steps.find((step) => step.step_id === entry.step_id);
    const position = stepPosition(entry);
    const nextStep = systemStep || existingStep
      ? mergeStep(systemStep || existingStep, entry)
      : userAddedStep(entry);
    stage.default_steps = insertStep(steps, nextStep, position);
  }

  return {
    stages,
    step_registry_path: userStepRegistryPath(),
    step_registry: {
      version: registry.version || 1,
      steps: registry.steps || [],
    },
    validation,
  };
}

function readStageSteps() {
  return readEffectiveStageSteps();
}

function stepRegistrySchema() {
  return {
    version: 1,
    registry_path: userStepRegistryPath(),
    required_for_user_added: ["stage", "step_id", "default_worker", "output_purpose"],
    required_for_user_override: ["stage", "step_id"],
    template: {
      fields: {
        stage: { required: true, description: "系统内置阶段 ID；第一版不支持新增阶段。" },
        step_id: { required: true, description: "阶段内步骤 ID；同阶段内唯一。" },
        title: { required: false, description: "给用户看的步骤标题。" },
        default_worker: { required: true, description: "默认推荐或执行的 skill。" },
        candidate_workers: { required: false, description: "该步骤可选 skill 列表。" },
        output_purpose: { required: true, description: "该步骤产物用途。" },
        condition: { required: false, description: "该步骤适用条件。" },
        position: { required: false, description: "步骤顺序，支持 before 或 after。" },
      },
      example: {
        stage: "development-execution",
        step_id: "ai_review",
        title: "AI Review",
        default_worker: "kfc-worker-code-review",
        candidate_workers: ["kfc-worker-code-review"],
        output_purpose: "记录 AI 代码复核结果。",
        position: { after: "development_record" },
      },
    },
  };
}

function readWorkerCatalog() {
  const text = readTextCatalog("worker-catalog.yaml");
  const lines = text.split(/\r?\n/);
  const result = { dependency_packages: [], stages: {} };
  let section = null;
  let currentStage = null;
  let currentSkill = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^dependency_packages:\s*$/.test(line)) {
      section = "dependency_packages";
      currentStage = null;
      continue;
    }
    if (/^stages:\s*$/.test(line)) {
      section = "stages";
      currentStage = null;
      continue;
    }
    const dep = line.match(/^  -\s*(.+)$/);
    if (section === "dependency_packages" && dep) {
      result.dependency_packages.push(parseScalar(dep[1]));
      continue;
    }
    const stage = line.match(/^  ([a-z0-9-]+):$/);
    if (section === "stages" && stage) {
      currentStage = stage[1];
      result.stages[currentStage] = { skills: [] };
      currentSkill = null;
      continue;
    }
    if (!currentStage) continue;
    const skill = line.match(/^      - name:\s*(.+)$/);
    if (skill) {
      currentSkill = { name: parseScalar(skill[1]) };
      result.stages[currentStage].skills.push(currentSkill);
      continue;
    }
    const field = line.match(/^        ([a-z_]+):\s*(.+)$/);
    if (field && currentSkill) {
      currentSkill[field[1]] = parseScalar(field[2]);
    }
  }

  return result;
}

function stageCatalog(stageId) {
  const catalog = readWorkerCatalog();
  return catalog.stages[stageId] || { skills: [] };
}

module.exports = {
  referencePath,
  readTextCatalog,
  readSystemStageSteps,
  readStageSteps,
  readEffectiveStageSteps,
  stepRegistrySchema,
  validateStepRegistry,
  readWorkerCatalog,
  stageCatalog,
};
