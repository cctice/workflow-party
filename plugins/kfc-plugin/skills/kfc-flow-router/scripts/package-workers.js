const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readSystemStageSteps } = require('./catalog');

// 开发者维护出厂注册表；与用户 steps/remove-skill 的配置作用域严格分开。
function removeBlock(text, stage, kind, id) {
  const lines = text.split('\n');
  let currentStage;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const stageMatch = lines[i].match(/^  ([a-z0-9-]+):$/);
    if (stageMatch) currentStage = stageMatch[1];
    const item = lines[i].match(new RegExp('^      - ' + kind + ':\\s*(.+)$'));
    if (currentStage === stage && item && item[1].trim() === id) { start = i; break; }
  }
  if (start < 0) throw new Error(`package registration not found: ${stage}.${id}`);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^ {7,}\S/.test(lines[end]))) end++;
  lines.splice(start, end - start);
  return lines.join('\n');
}

function removePackageSkill(args) {
  const stage = args.stage;
  const step = args.step || args['step-id'];
  const skill = args.skill || args.worker;
  const system = readSystemStageSteps();
  const target = system.stages[stage]?.default_steps.find((item) => item.step_id === step);
  if (!target || target.default_worker !== skill || !args['remove-step']) {
    throw new Error('包级注销固定 worker 必须指定其 stage、step、skill 和 --remove-step；普通用户配置请使用默认作用域。');
  }
  const root = path.resolve(__dirname, '../references');
  const names = ['stage-steps.yaml', 'worker-catalog.yaml', 'builtin-skill-registry.json'];
  const before = names.map((name) => fs.readFileSync(path.join(root, name), 'utf8'));
  const registry = JSON.parse(before[2]);
  for (const field of ['entries', 'default_skills']) {
    registry[field] = (registry[field] || []).filter((entry) => !(entry.stage === stage && entry.step_id === step && entry.skill === skill));
  }
  const after = [
    removeBlock(before[0], stage, 'step_id', step),
    removeBlock(before[1], stage, 'name', skill),
    JSON.stringify(registry, null, 2) + '\n',
  ];
  const remaining = system.stages[stage].default_steps.filter((item) => item.step_id !== step);
  if (remaining.some((item) => [item.default_worker, ...(item.candidate_workers || [])].includes(skill))) {
    throw new Error('该 worker 仍被同阶段其他步骤引用，请先通过注册表调整这些引用。');
  }
  const planHash = createHash('sha256').update(JSON.stringify({ stage, step, skill, before })).digest('hex');
  if (args.apply) {
    if (args.plan !== planHash) throw new Error('必须先预览，并使用未发生变化的 --plan 哈希执行。');
    const written = [];
    try {
      names.forEach((name, i) => {
        const destination = path.join(root, name);
        fs.writeFileSync(destination + '.tmp', after[i]);
        fs.renameSync(destination + '.tmp', destination);
        written.push(i);
      });
    } catch (error) {
      for (const i of written) fs.writeFileSync(path.join(root, names[i]), before[i]);
      for (const name of names) fs.rmSync(path.join(root, name) + '.tmp', { force: true });
      throw error;
    }
  }
  return {
    ok: true, scope: 'package', applied: Boolean(args.apply), stage, step_id: step, skill,
    plan_hash: planHash, removed_step: step,
    changed_files: names.map((name) => path.join(root, name)),
    user_registry_modified: false,
  };
}

module.exports = { removePackageSkill };
