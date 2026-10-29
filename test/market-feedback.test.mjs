// 反馈通道测试（维护心跳包·九轮）：市场此前的反馈回路为零——gatt 仓 issue 预填先例的市场版。
//   ① 脱敏三件：邮箱/绝对路径/长十六进制（令牌形态）一律替换为占位符，反馈者不怕手滑
//   ② 本地留档 stats/feedback.jsonl：插件@版本/kind/时间/脱敏正文逐条可回溯
//   ③ issue 预填 URL：指向本仓 issues/new，title/body 预填且 URL 编码正确（上架当天反馈即有去处）
//   ④ 未知名拒绝（不替不存在的插件编反馈）
//   ⑤ CLI 冒烟：feedback 子命令真实进程跑通（WFP_ROOT 临时根）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { submitFeedback, redactText } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-feedback-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  return tmp;
}

test("脱敏：邮箱/绝对路径/长十六进制令牌一律占位", () => {
  const out = redactText("联系 a.b@corp.com 或看 /Users/me/secret/key.log，token=deadbeefdeadbeefdeadbeef");
  assert.ok(!out.includes("a.b@corp.com") && out.includes("[email]"));
  assert.ok(!out.includes("/Users/me") && out.includes("[path]"));
  assert.ok(!out.includes("deadbeef") && out.includes("[token]"));
});

test("留档：feedback.jsonl 逐条追加，plugin/kind/时间如实", () => {
  const tmp = tmpRoot();
  const fb = submitFeedback(tmp, "kfc-plugin", "在 someone@x.com 的机器上装不上", { kind: "bug" });
  assert.equal(fb.record.plugin, "kfc-plugin@0.1.1");
  assert.equal(fb.record.kind, "bug");
  assert.ok(fb.record.text.includes("[email]"), "留档正文必须已脱敏");
  const lines = fs.readFileSync(path.join(tmp, "stats", "feedback.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  submitFeedback(tmp, "kaleidosphere", "希望能按 /Users/x/y 排序");
  assert.equal(fs.readFileSync(path.join(tmp, "stats", "feedback.jsonl"), "utf8").trim().split("\n").length, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("issue 预填 URL：指向本仓 issues/new，title/body 已编码", () => {
  const tmp = tmpRoot();
  const fb = submitFeedback(tmp, "afk", "建议支持多语言", { kind: "idea" });
  assert.ok(fb.url.startsWith("https://github.com/cctice/workflow-party/issues/new?"));
  const [_, qs] = fb.url.split("?");
  const params = new URLSearchParams(qs);
  assert.equal(params.get("title"), "[feedback][idea] afk@0.1.0");
  assert.ok(params.get("body").includes("已自动脱敏"));
  assert.ok(params.get("body").includes("建议支持多语言"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("未知名拒绝：不替不存在的插件编反馈", () => {
  const tmp = tmpRoot();
  assert.equal(submitFeedback(tmp, "no-such"), null);
  assert.ok(!fs.existsSync(path.join(tmp, "stats", "feedback.jsonl")), "拒绝时零写入");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("CLI 冒烟：feedback 子命令真实进程跑通（WFP_ROOT 临时根）", () => {
  const tmp = tmpRoot();
  const out = execFileSync(process.execPath, [path.join(root, "scripts", "market.mjs"), "feedback", "kfc-plugin", "很好用", "--kind", "review"],
    { encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp } });
  assert.match(out, /已留档（已脱敏）：很好用/);
  assert.match(out, /issues\/new\?title=/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
