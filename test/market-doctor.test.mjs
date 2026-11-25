// 数据面体检测试（维护心跳包·二十二轮）：market doctor 一条命令回真话。
//   ① 真实根全绿（只读冒烟）+ CLI 绿 exit 0 / 红 exit 1 行为面
//   ② 键覆盖双向：死键（名已下架）红 / 缺键（非 bundled 无 key）红 / 旧版本历史 key 如实列出不冒红
//   ③ 三本账坏行红（文件:行号点名不连坐）
//   ④ 事件序列：seq 重复红 / 水位超账红 / 未归账 install 红且指路 ingest
//   ⑤ 账实相符：counts 低于已折叠 install 数 = 丢账红
//   ⑥ trim 清账合法态：events 全部归档后（账空+水位>0）如实绿——不变量不误报
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { doctorMarket } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-doctor-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  return tmp;
}

const readJson = (tmp, rel) => JSON.parse(fs.readFileSync(path.join(tmp, rel), "utf8"));
const writeJson = (tmp, rel, data) => fs.writeFileSync(path.join(tmp, rel), JSON.stringify(data, null, 2) + "\n");
const appendLine = (tmp, file, row) => fs.appendFileSync(path.join(tmp, "stats", file), `${JSON.stringify(row)}\n`);
const checkOf = (result, id) => result.checks.find((c) => c.id === id);
const kindsOf = (result, id) => checkOf(result, id).findings.map((f) => f.kind);

const anyKey = () => Object.keys(readJson(tmpRoot(), "stats/downloads.json").counts)[0]; // kaleidosphere@0.4.2

test("真实根全绿：doctor 只读冒烟 5/5，CLI exit 0", () => {
  const result = doctorMarket(root);
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.equal(result.summary.checks, 5);
  const out = execFileSync("node", [path.join(root, "scripts", "market.mjs"), "doctor"], { encoding: "utf8" });
  assert.match(out, /体检通过：5\/5 项全绿/);
});

test("键覆盖双向：死键红/缺键红，旧版本历史 key 如实列出不冒红", () => {
  // 死键：插件名整体不在市场
  const dead = tmpRoot();
  const stats = readJson(dead, "stats/downloads.json");
  stats.counts["ghost-plugin@9.9.9"] = 3;
  writeJson(dead, "stats/downloads.json", stats);
  const deadResult = doctorMarket(dead);
  assert.equal(deadResult.ok, false);
  assert.deepEqual(kindsOf(deadResult, "downloads.key-coverage"), ["dead-key"]);

  // 缺键：非 bundled 条目无 key（与测试覆盖门同口径）
  const missing = tmpRoot();
  const stats2 = readJson(missing, "stats/downloads.json");
  delete stats2.counts["kfc-plugin@0.1.1"];
  writeJson(missing, "stats/downloads.json", stats2);
  const missingResult = doctorMarket(missing);
  assert.equal(missingResult.ok, false);
  assert.deepEqual(kindsOf(missingResult, "downloads.key-coverage"), ["missing-key"]);

  // 历史版本 key：名在场、版本退役——不冒红，historicalKeys 如实列出
  const historical = tmpRoot();
  const stats3 = readJson(historical, "stats/downloads.json");
  stats3.counts["kaleidosphere@0.4.1"] = 7;
  writeJson(historical, "stats/downloads.json", stats3);
  const histResult = doctorMarket(historical);
  assert.equal(histResult.ok, true);
  assert.deepEqual(kindsOf(histResult, "downloads.key-coverage"), []);
  assert.deepEqual(checkOf(histResult, "downloads.key-coverage").historicalKeys, ["kaleidosphere@0.4.1"]);
});

test("三本账坏行红：文件:行号点名不连坐", () => {
  const tmp = tmpRoot();
  appendLine(tmp, "feedback.jsonl", { at: new Date().toISOString(), plugin: "kaleidosphere@0.4.2", kind: "review", text: "好" });
  fs.appendFileSync(path.join(tmp, "stats", "feedback.jsonl"), "{oops-not-json\n");
  appendLine(tmp, "queries.jsonl", { q: "kaleido", at: new Date().toISOString() });
  const result = doctorMarket(tmp);
  assert.equal(result.ok, false);
  const findings = checkOf(result, "ledger.rows-parsable").findings;
  assert.deepEqual(findings.map((f) => f.kind), ["bad-row"]);
  assert.equal(findings[0].file, "feedback.jsonl");
  assert.equal(findings[0].line, 2, "坏行行号点名");
});

test("事件序列：seq 重复红/水位超账红/未归账 install 红且指路 ingest", () => {
  // seq 重复：锁失效或手改（水位=1 视作已归账，隔离出纯 seq 语义）
  const dup = tmpRoot();
  const key = anyKey();
  const dupStats = readJson(dup, "stats/downloads.json");
  dupStats.foldedSeq = 1;
  writeJson(dup, "stats/downloads.json", dupStats);
  appendLine(dup, "events.jsonl", { seq: 1, type: "install", plugin: key.split("@")[0], version: key.split("@")[1], consumer: "t", at: "2026-11-25T00:00:00Z" });
  appendLine(dup, "events.jsonl", { seq: 1, type: "install", plugin: key.split("@")[0], version: key.split("@")[1], consumer: "t", at: "2026-11-25T00:00:01Z" });
  const dupResult = doctorMarket(dup);
  assert.equal(dupResult.ok, false);
  assert.deepEqual(kindsOf(dupResult, "events.sequence"), ["duplicate-seq"]);

  // 水位超过账内最大 seq：事件账与下载台账脱节
  const wm = tmpRoot();
  appendLine(wm, "events.jsonl", { seq: 1, type: "install", plugin: key.split("@")[0], version: key.split("@")[1], consumer: "t", at: "2026-11-25T00:00:00Z" });
  const stats = readJson(wm, "stats/downloads.json");
  stats.foldedSeq = 99;
  writeJson(wm, "stats/downloads.json", stats);
  const wmResult = doctorMarket(wm);
  assert.equal(wmResult.ok, false);
  assert.deepEqual(kindsOf(wmResult, "events.sequence"), ["watermark-beyond-events"]);

  // 未归账 install（seq > 水位）：点名并指路 market ingest——record 当场归账，稳态应为 0
  const pending = tmpRoot();
  appendLine(pending, "events.jsonl", { seq: 5, type: "install", plugin: key.split("@")[0], version: key.split("@")[1], consumer: "t", at: "2026-11-25T00:00:00Z" });
  const pendingResult = doctorMarket(pending);
  assert.equal(pendingResult.ok, false);
  const seqFindings = checkOf(pendingResult, "events.sequence").findings;
  assert.deepEqual(seqFindings.map((f) => f.kind), ["pending-install"]);
  assert.match(seqFindings[0].hint, /market\.mjs ingest/);
});

test("账实相符：counts 低于已折叠 install 数 = 丢账红", () => {
  const tmp = tmpRoot();
  const key = anyKey();
  const stats = readJson(tmp, "stats/downloads.json");
  stats.foldedSeq = 2;
  writeJson(tmp, "stats/downloads.json", stats);
  appendLine(tmp, "events.jsonl", { seq: 1, type: "install", plugin: key.split("@")[0], version: key.split("@")[1], consumer: "t", at: "2026-11-25T00:00:00Z" });
  appendLine(tmp, "events.jsonl", { seq: 2, type: "install", plugin: key.split("@")[0], version: key.split("@")[1], consumer: "t", at: "2026-11-25T00:00:01Z" });
  // counts 停在 0：两条已折叠 install 凭空消失 = 丢账
  const result = doctorMarket(tmp);
  assert.equal(result.ok, false);
  const findings = checkOf(result, "downloads.counts-vs-events").findings;
  assert.deepEqual(findings.map((f) => f.kind), ["counts-below-folded"]);
  assert.equal(findings[0].key, key);
  assert.equal(findings[0].counts, 0);
  assert.equal(findings[0].folded, 2);
});

test("manifest 结构：重复名红/integrity 形态红；trim 清账合法态（账空+水位>0）如实绿", () => {
  const dup = tmpRoot();
  const manifest = readJson(dup, ".claude-plugin/marketplace.json");
  manifest.plugins.push({ ...manifest.plugins[0], integrity: undefined, "bundled-in-kaleidosphere": true });
  writeJson(dup, ".claude-plugin/marketplace.json", manifest);
  const dupResult = doctorMarket(dup);
  assert.equal(dupResult.ok, false);
  assert.deepEqual(kindsOf(dupResult, "marketplace.manifest"), ["duplicate-name"]);

  const badIntegrity = tmpRoot();
  const manifest2 = readJson(badIntegrity, ".claude-plugin/marketplace.json");
  manifest2.plugins[0].integrity = "sha256:not-a-hash";
  writeJson(badIntegrity, ".claude-plugin/marketplace.json", manifest2);
  assert.deepEqual(kindsOf(doctorMarket(badIntegrity), "marketplace.manifest"), ["malformed-integrity"]);

  // trim/归档把已归账旧事件全部裁走后：events 空 + 水位>0 + counts 在账 = 合法态，不冒红
  const trimmed = tmpRoot();
  fs.writeFileSync(path.join(trimmed, "stats", "events.jsonl"), "");
  const stats = readJson(trimmed, "stats/downloads.json");
  stats.foldedSeq = 3;
  stats.counts["kaleidosphere@0.4.2"] = 3;
  writeJson(trimmed, "stats/downloads.json", stats);
  const trimmedResult = doctorMarket(trimmed);
  assert.equal(trimmedResult.ok, true, JSON.stringify(trimmedResult.checks.filter((c) => !c.ok)));
});

test("CLI 行为面：绿 exit 0 / 红 exit 1（真进程，WFP_ROOT 临时根）", () => {
  const run = (tmp) => spawnSync(process.execPath, [path.join(root, "scripts", "market.mjs"), "doctor"], {
    encoding: "utf8",
    env: { ...process.env, WFP_ROOT: tmp },
  });
  const green = run(tmpRoot());
  assert.equal(green.status, 0);
  assert.match(green.stdout, /体检通过/);
  const red = tmpRoot();
  const stats = readJson(red, "stats/downloads.json");
  stats.counts["ghost@1.0.0"] = 1;
  writeJson(red, "stats/downloads.json", stats);
  const redRun = run(red);
  assert.equal(redRun.status, 1);
  assert.match(redRun.stdout, /体检不过：1\/5 项红/);
  assert.match(redRun.stdout, /dead-key/);
});
