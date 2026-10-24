#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const routerScript = path.resolve(__dirname, '..', '..', 'kfc-flow-router', 'scripts', 'kfc.js');
const args = process.argv.slice(2);
const command = args[0];

if (!fs.existsSync(routerScript)) {
  console.error('[kfc] 路由推进器未找到：' + routerScript);
  process.exit(1);
}

function rootFromArgs(argv) {
  const index = argv.indexOf('--root');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return process.cwd();
}

function hookDisplayName(agent) {
  const names = {
    codex: 'Codex',
    'claude-code': 'Claude Code',
    kiro: 'Kiro',
  };
  return names[agent] || agent;
}

function userFriendlyHookGuidance(check) {
  if (!check || check.ok === false) {
    return {
      status: 'check_failed',
      user_message: 'KFC 暂时没检查到“忘记输入 /kfc 时也能自动先走 KFC”的本机规则，本次流程会继续。',
      detail: check && (check.error || check.stderr || check.stdout) || '',
    };
  }
  const missing = Array.isArray(check.missing_hooks) ? check.missing_hooks : [];
  if (!missing.length) {
    return {
      status: 'ready',
      user_message: '你以后忘了输入 /kfc 也没关系；开发类任务会先自动按 KFC 处理。安装或更新后，Codex 需要在 /hooks 里信任一次；如果使用 App，建议重启 App 并打开新会话，授权入口通常会显示在对话框上方。',
      missing_agents: [],
    };
  }
  return {
    status: 'install_available',
    user_message: '你以后忘了输入 /kfc 也没关系。开启后，当你直接说“看 bug、排查性能问题、改代码、写测试、改文档”这类开发任务时，我会先自动按 KFC 走一遍，帮你记录当前进度和下一步建议。普通聊天不受影响。要现在开启吗？',
    install_note: '如果用户同意，AI 应先说明这会给当前使用的 AI 开发工具加一条本机规则，并列出将修改的配置文件；用户再次确认后再执行 hooks-install。安装或更新后，Codex 需要在 /hooks 里信任一次；如果使用 App，建议重启 App 并打开新会话，授权入口通常会显示在对话框上方。',
    missing_agents: missing.map((item) => ({
      agent: item.agent,
      display_name: hookDisplayName(item.agent),
      config_file: item.hook_path,
      scope: item.install_scope,
    })),
  };
}

function hookCommand(argv) {
  if (command !== 'hooks') return null;
  const action = argv[1] || 'check';
  const agentIndex = argv.indexOf('--agent');
  const agent = agentIndex >= 0 && argv[agentIndex + 1] ? argv[agentIndex + 1] : 'all';
  if (action === 'on') {
    return {
      action,
      routerArgs: ['hooks-install', '--root', rootFromArgs(argv), '--agent', agent],
    };
  }
  if (action === 'off') {
    return {
      action,
      routerArgs: ['hooks-remove', '--root', rootFromArgs(argv), '--agent', agent],
    };
  }
  return {
    action: 'check',
    routerArgs: ['hooks-check', '--root', rootFromArgs(argv)],
  };
}

function maybeRunHookCheck(argv, resolvedHookCommand) {
  if (!resolvedHookCommand || resolvedHookCommand.action !== 'check') return null;
  const check = spawnSync(process.execPath, [routerScript, 'hooks-check', '--root', rootFromArgs(argv)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (check.error) {
    return userFriendlyHookGuidance({
      ok: false,
      error: check.error.message || String(check.error),
    });
  }
  try {
    return userFriendlyHookGuidance(JSON.parse(check.stdout || '{}'));
  } catch (error) {
    return userFriendlyHookGuidance({
      ok: false,
      error: error.message,
      stdout: check.stdout,
      stderr: check.stderr,
    });
  }
}

function hookOperationSlot(action, parsedOutput) {
  if (!parsedOutput) return null;
  if (action === 'on') {
    return parsedOutput.ok === false
      ? 'KFC 本机规则开启失败，请查看 hook_operation 详情。'
      : 'KFC 本机规则已按当前已安装的 AI 开发工具执行开启；未安装的工具会自动跳过。';
  }
  if (action === 'off') {
    return parsedOutput.ok === false
      ? 'KFC 本机规则关闭失败，请查看 hook_operation 详情。'
      : 'KFC 本机规则已执行关闭；只会移除 KFC 自己写入的本机规则，其他规则不会被删除。';
  }
  return null;
}

function parseJsonOutput(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

const resolvedHookCommand = hookCommand(args);
const hookGuidance = maybeRunHookCheck(args, resolvedHookCommand);
const routerArgs = resolvedHookCommand ? resolvedHookCommand.routerArgs : args;
const result = spawnSync(process.execPath, [routerScript, ...routerArgs], {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'pipe'],
});

if (result.error) {
  console.error('[kfc] 路由推进器执行失败：' + (result.error.message || String(result.error)));
  process.exit(1);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

const parsedOutput = parseJsonOutput(result.stdout || '');
if (parsedOutput && resolvedHookCommand) {
  if (hookGuidance) {
    parsedOutput.hook_guidance = hookGuidance;
  }
  const operationSlot = hookOperationSlot(resolvedHookCommand.action, parsedOutput);
  parsedOutput.user_output_slots = parsedOutput.user_output_slots || {};
  if (hookGuidance) {
    parsedOutput.user_output_slots.hook_guidance = hookGuidance.user_message;
  }
  if (operationSlot) {
    parsedOutput.user_output_slots.hook_operation = operationSlot;
  }
  process.stdout.write(`${JSON.stringify(parsedOutput, null, 2)}\n`);
} else {
  if (hookGuidance && hookGuidance.status === 'install_available') {
    process.stdout.write(`[kfc] ${hookGuidance.user_message}\n`);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
}

process.exit(typeof result.status === 'number' ? result.status : 1);
