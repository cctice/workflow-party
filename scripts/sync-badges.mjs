#!/usr/bin/env node
// 徽章自动刷（维护心跳包·十三轮）：tests 徽章从"静态口径人肉跟"变"一条命令+对账门"。
// 痛点（十二轮留题）：README/README_CN 双语 tests-XX%20passing 徽章是静态数字，
// 每次增删用例都要人记得刷——十轮已有 134→162 没人跟的前科（gatt 仓同病已治）。
// 口径：
//   - 权威计数 = test/*.test.mjs 顶层 test() 静态计数（与 manifest-sync 门同源逻辑）；
//   - 默认真跑 node --test 全绿才刷（红着不粉饰，非零退出如实报）；--no-run 跳过（CI 递归防环/演练）；
//   - --check 只读对账：徽章≠计数即红，指路 npm run sync:badges；
//   - 双语同刷同值（README_CN 门继续看守）。
// 用法：node scripts/sync-badges.mjs [--check] [--no-run] [--root DIR]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const noRun = args.includes("--no-run");
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : defaultRoot;

function declaredTests() {
  const dir = path.join(root, "test");
  let declared = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"))) {
    declared += (fs.readFileSync(path.join(dir, file), "utf8").match(/^test\(/gm) || []).length;
  }
  return declared;
}

const badgeValue = (source) => source.match(/badge\/tests-(\d+)%20passing-/)?.[1];
const setBadge = (source, n) => source.replace(/(badge\/tests-)\d+(%20passing-)/, `$1${n}$2`);

const declared = declaredTests();
const files = ["README.md", "README_CN.md"].map((f) => path.join(root, f));
const currents = files.map((f) => badgeValue(fs.readFileSync(f, "utf8")));

if (currents.some((c) => c === undefined)) {
  console.error("[sync-badges] README/README_CN 缺 tests 徽章，无从对账");
  process.exit(2);
}

if (check) {
  const drifted = currents.filter((c) => Number(c) !== declared);
  if (drifted.length > 0) {
    console.error(`[sync-badges] 徽章（${currents.join(", ")}）≠ 用例计数（${declared}）——跑 npm run sync:badges 刷新`);
    process.exit(1);
  }
  console.log(`[sync-badges] tests 徽章 ${declared} passing 与用例计数一致`);
  process.exit(0);
}

if (currents.every((c) => Number(c) === declared)) {
  console.log(`[sync-badges] tests 徽章已是 ${declared} passing，无需刷`);
  process.exit(0);
}

if (!noRun) {
  // 真跑门：全绿才刷——红着把徽章刷绿等于粉饰
  const run = spawnSync(process.execPath, ["--test"], { cwd: root, encoding: "utf8", env: { ...process.env, WFP_SYNC_BADGES: "1" } });
  const pass = Number((run.stdout.match(/^# pass (\d+)$/m) || [])[1] ?? NaN);
  const fail = Number((run.stdout.match(/^# fail (\d+)$/m) || [])[1] ?? NaN);
  if (run.status !== 0 || !Number.isFinite(pass) || fail > 0) {
    console.error(`[sync-badges] 测试未全绿（pass=${pass} fail=${fail}），徽章不刷——先修红再谈徽章`);
    process.exit(1);
  }
  // 注：实跑 pass 含子测试，可大于静态声明计数（口径合法差异），徽章真源仍是静态声明计数。
}

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, setBadge(source, declared));
}
console.log(`[sync-badges] tests 徽章 ${currents.join("/")} → ${declared} passing（README.md + README_CN.md 双语同刷）`);
