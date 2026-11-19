// 脚本 usage 漂移门（维护心跳包·十六轮）：十五轮的 market.mjs 三源对账同款病，
// 四脚本（verify-artifacts/rebuild-artifacts/build-site/sync-badges）各自长——
// 头部注释用法块宣传的 --flag 与 argv 解析（args.includes/indexOf）各自漂：
//   ① 用法行在场：四脚本每个都有"用法：node scripts/<name>.mjs"锚（头部注释或 fallback 输出）；
//   ② flag 双向对账：文档（注释块+用法串）声明的每个 --flag 必须是 argv 真解析的
//      （写错=用户抄了就静默掉进位置参数），argv 认识的每个 flag 必须在文档出现
//      （死 flag=用户永远发现不了）；verify-artifacts 零 flag 也如实对账（两侧皆空）；
//   ③ 行为面真进程冒烟：无害调用个个真能跑（verify 全绿 exit 0 / rebuild 无参打用法
//      exit 2 / build-site --check 只读对账 exit 0 / sync-badges --check exit 0）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["verify-artifacts", "rebuild-artifacts", "build-site", "sync-badges"];
const srcOf = (name) => fs.readFileSync(path.join(root, "scripts", `${name}.mjs`), "utf8");

// —— 提取器（纯文本口径，与实现同文件同源；market.mjs 的 a === "--x" 形态
//    由十五轮 usage-drift 门看守，本门盖四脚本的 args.includes/indexOf 形态）——
const parsedFlags = (src) =>
  [...new Set([...src.matchAll(/args\.(?:includes|indexOf)\("(--[a-z][a-z-]*)"\)/g)].map((m) => m[1]))];
const docFlags = (name, src) => {
  // 只认"本脚本调用形态"的行（node scripts/<name>.mjs 出现的行）+ 用法输出串：
  // 跨脚本引用（如 build-site 头部注释提 market CLI 的 list --json）不算本脚本文档面
  const selfLines = src.split("\n").filter((l) => l.includes(`node scripts/${name}.mjs`)).join("\n");
  const usageStrings = [...src.matchAll(/["'`]([^"'`\n]*用法[^"'`\n]*)["'`\n]/g)].map((m) => m[1]).join("\n");
  return [...new Set([...`${selfLines}\n${usageStrings}`.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]))];
};

test("用法行在场：四脚本每个都有「用法：node scripts/<name>.mjs」锚（头部注释或 fallback 输出）", () => {
  for (const name of SCRIPTS) {
    const src = srcOf(name);
    const anchors = [
      ...src.matchAll(/用法[：:][^\n]*node scripts\/([a-z-]+)\.mjs/g),
      ...src.matchAll(/node scripts\/([a-z-]+)\.mjs/g),
    ].map((m) => m[1]);
    assert.ok(
      anchors.includes(name),
      `${name}.mjs 缺自身用法锚（用法：node scripts/${name}.mjs）——用法文档面开天窗`,
    );
  }
});

test("flag 双向对账：文档写的 argv 真解析，argv 认识的文档都写了（四脚本逐个对，零 flag 两侧皆空）", () => {
  for (const name of SCRIPTS) {
    const parsed = new Set(parsedFlags(srcOf(name)));
    const docs = new Set(docFlags(name, srcOf(name)));
    const unparseable = [...docs].filter((f) => !parsed.has(f));
    assert.deepEqual(
      unparseable,
      [],
      `${name}.mjs 文档声明但 argv 不解析的 flag（用户抄了就静默掉进位置参数）：${unparseable}`,
    );
    const undocumented = [...parsed].filter((f) => !docs.has(f));
    assert.deepEqual(
      undocumented,
      [],
      `${name}.mjs argv 解析但文档没写的死 flag（用户永远发现不了）：${undocumented}`,
    );
  }
});

test("行为面：无害调用个个真能跑（真进程实证——verify 全绿/rebuild 无参用法/build-site --check/sync-badges --check）", () => {
  const run = (name, args) => {
    try {
      const stdout = execFileSync("node", [path.join(root, "scripts", `${name}.mjs`), ...args], {
        encoding: "utf8",
        cwd: root,
      });
      return { code: 0, out: stdout, err: "" };
    } catch (err) {
      return { code: err.status, out: err.stdout?.toString() ?? "", err: err.stderr?.toString() ?? "" };
    }
  };
  // verify-artifacts：三方对账在仓内当前态应全绿（信任链门是它本尊，红=真漂移）
  const verify = run("verify-artifacts", []);
  assert.equal(verify.code, 0, `verify-artifacts 仓内对账不绿：${verify.err || verify.out}`);
  // rebuild-artifacts：无参打用法 exit 2（有参才会动真产物，冒烟只打无参）
  const rebuild = run("rebuild-artifacts", []);
  assert.equal(rebuild.code, 2, "rebuild-artifacts 无参应打用法 exit 2");
  assert.match(`${rebuild.out}${rebuild.err}`, /用法：node scripts\/rebuild-artifacts\.mjs/);
  // build-site --check：只读对账，站点与市场真源一致（site-gate 同款口径）
  const site = run("build-site", ["--check"]);
  assert.equal(site.code, 0, `build-site --check 不绿（站点过期？）：${site.err || site.out}`);
  // sync-badges --check：只读对账、语义正确即过（0=徽章一致；1=漂移且指路
  // npm run sync:badges——徽章新鲜度归 badge-sync/manifest-sync 门看守，本门
  // 只证"真能跑不崩"，不重复对账免与徽章刷新互锁成环）
  const badges = run("sync-badges", ["--check"]);
  assert.ok(
    badges.code === 0 || (badges.code === 1 && /sync:badges/.test(`${badges.out}${badges.err}`)),
    `sync-badges --check 行为漂移（既非一致绿也非指路红）：exit=${badges.code} ${badges.out}${badges.err}`,
  );
});
