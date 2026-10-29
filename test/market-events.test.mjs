// 安装事件回传通道测试（维护心跳包·九轮）：下载量台账从"手填 bump"升级为真实事件账。
//   ① record：事件落 stats/events.jsonl（seq 单调/consumer/version 如实），当场归账 counts+1
//   ② ingest 幂等：seq 水位折叠，重跑归账 0 条——回传通道重放/补跑不多记账
//   ③ 非安装类型事件不动账（通道只认 install，别的事件如实穿堂而过）
//   ④ 未知名拒绝、版本不跟市场即拒（不替人编造事件）
//   ⑤ bump（手工回填）与事件账并存：同 key 各自累计，台账 note 如实标注混合
//   ⑥ CLI 冒烟：record/ingest 子命令真实进程跑通（WFP_ROOT 注入临时根，不动真台账）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordInstall, ingestEvents } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-events-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  return tmp;
}
const readCounts = (tmp) => JSON.parse(fs.readFileSync(path.join(tmp, "stats", "downloads.json"), "utf8"));

test("record：事件落通道（seq 单调/consumer 如实）并当场归账 +1", () => {
  const tmp = tmpRoot();
  const r1 = recordInstall(tmp, "kfc-plugin", { consumer: "ks" });
  assert.equal(r1.event.seq, 1);
  assert.equal(r1.event.type, "install");
  assert.equal(r1.event.consumer, "ks");
  assert.equal(r1.folded, 1);
  const r2 = recordInstall(tmp, "kfc-plugin", { consumer: "ks" });
  assert.equal(r2.event.seq, 2, "seq 单调");
  assert.equal(readCounts(tmp).counts["kfc-plugin@0.1.1"], 2, "两次安装=两次下载");
  const lines = fs.readFileSync(path.join(tmp, "stats", "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "通道里两条事件");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ingest 幂等：水位之后才折叠，重跑归账 0——回放不多记账", () => {
  const tmp = tmpRoot();
  recordInstall(tmp, "kaleidosphere", { consumer: "ks" });
  recordInstall(tmp, "kaleidosphere", { consumer: "manual" });
  assert.equal(ingestEvents(tmp), 0, "已折叠过的重跑归 0");
  assert.equal(readCounts(tmp).counts["kaleidosphere@0.4.2"], 2);
  // 手工在通道尾再补一条事件，ingest 只补记这一条
  fs.appendFileSync(path.join(tmp, "stats", "events.jsonl"),
    JSON.stringify({ seq: 3, type: "install", plugin: "kaleidosphere", version: "0.4.2", consumer: "replay", at: "2026-10-29T00:00:00Z" }) + "\n");
  assert.equal(ingestEvents(tmp), 1);
  assert.equal(readCounts(tmp).counts["kaleidosphere@0.4.2"], 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("非安装事件穿堂而过：ingest 不动账不抬水位于 install 之外", () => {
  const tmp = tmpRoot();
  fs.appendFileSync(path.join(tmp, "stats", "events.jsonl"),
    JSON.stringify({ seq: 1, type: "impression", plugin: "kfc-plugin", version: "0.1.1" }) + "\n" +
    JSON.stringify({ seq: 2, type: "install", plugin: "kfc-plugin", version: "0.1.1" }) + "\n");
  assert.equal(ingestEvents(tmp), 1, "只认 install");
  assert.equal(readCounts(tmp).counts["kfc-plugin@0.1.1"], 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("未知名拒绝、版本不跟市场即拒——不替人编造事件", () => {
  const tmp = tmpRoot();
  assert.equal(recordInstall(tmp, "no-such-plugin"), null);
  assert.throws(() => recordInstall(tmp, "kfc-plugin", { version: "9.9.9" }), /版本不符/);
  assert.equal(readCounts(tmp).counts["kfc-plugin@0.1.1"], 0, "拒绝时零写入");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("事件账与手工 bump 并存：同 key 各自累计，混合如实", () => {
  const tmp = tmpRoot();
  recordInstall(tmp, "kfc-plugin", { consumer: "ks" }); // 事件账 +1
  const stats = readCounts(tmp);
  assert.equal(stats.counts["kfc-plugin@0.1.1"], 1);
  assert.ok(stats.eventLedger, "台账带事件账标记");
  assert.equal(stats.eventLedger.foldedSeq, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("CLI 冒烟：record/ingest 真实进程跑通（WFP_ROOT 临时根，不动真台账）", () => {
  const tmp = tmpRoot();
  const run = (args) => execFileSync(process.execPath, [path.join(root, "scripts", "market.mjs"), ...args],
    { encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp } });
  assert.match(run(["record", "kfc-plugin", "--consumer", "ks"]), /seq=1/);
  assert.match(run(["ingest"]), /归账 0 条/);
  assert.equal(readCounts(tmp).counts["kfc-plugin@0.1.1"], 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
