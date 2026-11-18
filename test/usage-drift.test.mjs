// usage 漂移门（维护心跳包·十五轮）：market CLI 子命令面渐宽，
// 用法字符串（头部注释 + fallback 用法行）与实现（if/else 分支、parseArgs flag 表）各自长——
// 十四轮 archive、十二轮 trim 就是先例：子命令上了，头部注释没跟。
// 本门三源对账，谁漂谁红：
//   ① 子命令三源相等：实现（cmd === "x" 分支）≡ fallback 用法行 ≡ 头部注释用法块；
//   ② flag 双向对账：文档声明的每个 --flag 必须是 parseArgs 认识的（写错=用户抄了就吞），
//      parseArgs 认识的每个 flag 必须在文档出现（死 flag=用户永远发现不了）；
//   ③ 行为面：无参打用法 exit 0，未知子命令打用法 exit 1（真进程实证）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "scripts", "market.mjs"), "utf8");

// —— 提取器（纯文本口径，与实现同文件同源）——
const implementedCmds = () => [...src.matchAll(/cmd === "([a-z][a-z-]*)"/g)].map((m) => m[1]);
const headerCmds = () => [...src.matchAll(/^\/\/\s+node scripts\/market\.mjs ([a-z][a-z-]*)/gm)].map((m) => m[1]);
const fallbackUsageLine = () => src.match(/console\.log\("用法：market ([^"]+)"\)/)?.[1] ?? "";
// fallback 行以 " | " 分段（bracket 内的 bug|idea|review 无空格不受切分影响），每段首词即子命令
const fallbackCmds = () => fallbackUsageLine().split(" | ").map((seg) => seg.trim().split(/\s+/)[0]).filter((w) => /^[a-z][a-z-]*$/.test(w));
const parseArgsFlags = () => [...src.matchAll(/a === "(--[a-z][a-z-]*)"/g)].map((m) => m[1]);
const docFlags = () => {
  const header = [...src.matchAll(/^\/\/.*$/gm)].map((m) => m[0]).join("\n"); // 头部注释整块（含用法块）
  return [...new Set([...`${header}\n${fallbackUsageLine()}`.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]))];
};

test("子命令三源对齐：实现 ≡ fallback 用法行 ≡ 头部注释——谁漂谁红（首跑抓真漂移：头部注释缺 trim/archive）", () => {
  const impl = new Set(implementedCmds());
  const fb = new Set(fallbackCmds());
  const hdr = new Set(headerCmds());
  const diff = (a, b, la, lb) => {
    const onlyA = [...a].filter((x) => !b.has(x));
    const onlyB = [...b].filter((x) => !a.has(x));
    return onlyA.length || onlyB.length ? `\n  仅${la}有: ${JSON.stringify(onlyA)}\n  仅${lb}有: ${JSON.stringify(onlyB)}` : "";
  };
  assert.ok(impl.size > 0, "提取器失明：cmd === 分支一个没抓到（检查 market.mjs 结构）");
  assert.ok(fb.size > 0 && hdr.size > 0, "用法文档面缺失：fallback 行或头部注释提取为空");
  assert.ok(!diff(impl, fb, "实现", "fallback 用法行"), `实现 vs fallback 用法行漂移${diff(impl, fb, "实现", "fallback 用法行")}`);
  assert.ok(!diff(impl, hdr, "实现", "头部注释"), `实现 vs 头部注释漂移${diff(impl, hdr, "实现", "头部注释")}`);
});

test("flag 双向对账：文档写的 parseArgs 都认识，parseArgs 认识的文档都写了", () => {
  const parsed = new Set(parseArgsFlags());
  const docs = new Set(docFlags());
  assert.ok(parsed.size >= 5, `parseArgs flag 表提取异常（仅 ${parsed.size} 个）`);
  const unparseable = [...docs].filter((f) => !parsed.has(f));
  assert.deepEqual(unparseable, [], `文档声明但 parseArgs 不认识的 flag（用户抄了就静默掉进位置参数）：${unparseable}`);
  const undocumented = [...parsed].filter((f) => !docs.has(f));
  assert.deepEqual(undocumented, [], `parseArgs 认识但文档没写的死 flag（用户永远发现不了）：${undocumented}`);
});

test("行为面：无参打用法 exit 0；未知子命令打用法 exit 1；用法行宣传的子命令个个真能跑（真进程实证，WFP_ROOT 临时根防真台账污染）", () => {
  const run = (args, env = {}) => {
    try {
      const stdout = execFileSync("node", [path.join(root, "scripts", "market.mjs"), ...args], {
        encoding: "utf8", env: { ...process.env, ...env },
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout?.toString() ?? "" };
    }
  };
  const noArgs = run([]);
  assert.equal(noArgs.code, 0, "无参=看用法，不报错");
  assert.match(noArgs.stdout, /用法：market/);
  const unknown = run(["definitely-not-a-cmd"]);
  assert.equal(unknown.code, 1, "未知子命令 exit 1");
  assert.match(unknown.stdout, /用法：market/);
  // 用法行宣传的每个子命令都能真跑：WFP_ROOT 指临时根，写面（bump/record/feedback/trim/search 热度）不碰真台账
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-usage-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  const anyPlugin = "kaleidosphere";
  const cmdArgs = {
    list: [], search: [anyPlugin], info: [anyPlugin], stats: [], bump: [anyPlugin],
    record: [anyPlugin], ingest: [], feedback: [anyPlugin, "用法门冒烟"], report: [],
    trim: [], archive: ["--grep", "smoke", "--live"],
  };
  try {
    for (const cmd of fallbackCmds()) {
      const r = run([cmd, ...(cmdArgs[cmd] ?? [])], { WFP_ROOT: tmp });
      assert.equal(r.code, 0, `用法行宣传的子命令 ${cmd} 实际跑挂（宣传与实现漂移）`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
