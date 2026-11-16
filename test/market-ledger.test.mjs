// 台账自治测试（维护心跳包·十二轮）：三本账 jsonl 只增不删 → 封顶收敛。
//   ① 有界追加：超 WFP_LEDGER_MAX 自动收敛保最新，ledger-state.json 记账
//   ② 未归账保护：events.jsonl 里 seq > 折叠水位的事件裁剪时永不丢
//   ③ 手动面：market trim --max N 收敛三本账；WFP_LEDGER_MAX=0 自治关闭
//   ④ report 面挂台账健康（行数/封顶/累计裁剪如实可见）
//   ⑤ 收敛原子性：裁剪后文件仍是合法 jsonl、相对顺序不变
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendLedger, trimLedger, ledgerHealth, ledgerMax, logQuery, recordInstall, ingestEvents,
} from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-ledger-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  return tmp;
}

const readLines = (tmp, file) => fs.readFileSync(path.join(tmp, "stats", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("有界追加：超封顶自动收敛保最新，ledger-state 记累计裁剪", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "5";
  try {
    for (let i = 1; i <= 7; i += 1) logQuery(tmp, `q${i}`);
    const rows = readLines(tmp, "queries.jsonl");
    assert.equal(rows.length, 5, "收敛到封顶 5");
    assert.deepEqual(rows.map((r) => r.q), ["q3", "q4", "q5", "q6", "q7"], "保最新、相对顺序不变");
    const state = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "ledger-state.json"), "utf8"));
    assert.equal(state["queries.jsonl"].trimmedTotal, 2, "裁剪量记账");
    const health = ledgerHealth(tmp).find((l) => l.file === "queries.jsonl");
    assert.equal(health.lines, 5);
    assert.equal(health.trimmedTotal, 2);
    assert.equal(health.max, 5);
  } finally {
    delete process.env.WFP_LEDGER_MAX;
  }
});

test("未归账保护：events 裁剪永不丢 seq > 折叠水位的事件", () => {
  const tmp = tmpRoot();
  const market = JSON.parse(fs.readFileSync(path.join(tmp, ".claude-plugin", "marketplace.json"), "utf8"));
  const anyPlugin = market.plugins[0].name;
  // 归账 1 条（水位=1），再灌 8 条未归账事件（seq 2..9），封顶 5
  recordInstall(tmp, anyPlugin, { consumer: "test" });
  ingestEvents(tmp);
  process.env.WFP_LEDGER_MAX = "5";
  const protect = (e) => (e.seq || 0) > 1;
  try {
    for (let i = 0; i < 8; i += 1) {
      appendLedger(tmp, "events.jsonl", { seq: 2 + i, type: "install", plugin: anyPlugin, at: new Date().toISOString() }, protect);
    }
    // 阶段一：8 条未归账全部保住（保护赢过封顶）；唯一可裁的是已归账的 seq=1
    let rows = readLines(tmp, "events.jsonl");
    assert.equal(rows.length, 8, "8 条未归账一条不丢（已归账 seq=1 让位）");
    assert.ok(rows.every((r) => r.seq >= 2 && r.seq <= 9), "未归账全在");

    // 阶段二：全部归账（水位=9）后再追加 → 未保护的老事件可裁，保最新 5 条
    ingestEvents(tmp);
    const protect2 = (e) => (e.seq || 0) > 9;
    appendLedger(tmp, "events.jsonl", { seq: 10, type: "install", plugin: anyPlugin, at: new Date().toISOString() }, protect2);
    rows = readLines(tmp, "events.jsonl");
    assert.equal(rows.length, 5, "归账后收敛到封顶");
    assert.deepEqual(rows.map((r) => r.seq), [6, 7, 8, 9, 10], "保最新、相对顺序不变");
  } finally {
    delete process.env.WFP_LEDGER_MAX;
  }
});

test("手动面：market trim --max 收敛三本账；WFP_LEDGER_MAX=0 自治关闭如实", () => {
  const tmp = tmpRoot();
  for (let i = 0; i < 6; i += 1) logQuery(tmp, `q${i}`);
  const out = execFileSync(process.execPath, [path.join(root, "scripts", "market.mjs"), "trim", "--max", "3"], {
    env: { ...process.env, WFP_ROOT: tmp },
    encoding: "utf8",
  });
  assert.match(out, /queries\.jsonl\s+6 → 3（裁 3，归档 3 行 → queries-[\w-]+\.jsonl）/); // 十三轮：裁即归档
  assert.equal(readLines(tmp, "queries.jsonl").length, 3);

  // 自治关闭：0 = 不裁（如实陈述，不静默关停）
  process.env.WFP_LEDGER_MAX = "0";
  try {
    assert.equal(ledgerMax(), 0);
    logQuery(tmp, "one-more");
    assert.equal(readLines(tmp, "queries.jsonl").length, 4, "关闭态不裁");
  } finally {
    delete process.env.WFP_LEDGER_MAX;
  }
});

test("report 面挂台账健康：三本账行数/封顶/累计裁剪如实可见", async () => {
  const tmp = tmpRoot();
  logQuery(tmp, "hello");
  const { buildReport, loadCatalog } = await import("../scripts/market.mjs");
  const report = buildReport(loadCatalog(tmp), tmp);
  assert.equal(report.ledgers.length, 3);
  const q = report.ledgers.find((l) => l.file === "queries.jsonl");
  assert.equal(q.lines, 1);
  assert.equal(q.trimmedTotal, 0);
  assert.ok(report.ledgers.every((l) => typeof l.max === "number" && l.bytes >= 0));
});

test("收敛原子性：裁剪后文件合法 jsonl，无 .tmp 残留", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "2";
  try {
    for (let i = 0; i < 4; i += 1) appendLedger(tmp, "feedback.jsonl", { at: `2026-01-0${i + 1}`, text: `t${i}` });
    assert.equal(fs.existsSync(path.join(tmp, "stats", "feedback.jsonl.tmp")), false, "无 tmp 残留");
    const rows = readLines(tmp, "feedback.jsonl");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.text), ["t2", "t3"]);
  } finally {
    delete process.env.WFP_LEDGER_MAX;
  }
});

// ---- 归档面（十三轮）：封顶前的历史明细可再审计 ----
const archiveFiles = (tmp, prefix) => {
  const dir = path.join(tmp, "stats", "archive");
  try { return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort(); } catch { return []; }
};

test("归档面：被裁行落 archive/ 且内容一致，ledger-state 记账，守恒不丢行", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "3";
  try {
    for (let i = 0; i < 8; i += 1) appendLedger(tmp, "feedback.jsonl", { at: `2026-01-0${i + 1}`, text: `f${i}` });
    const rows = readLines(tmp, "feedback.jsonl");
    assert.equal(rows.length, 3, "保尾部 3 条");
    // appendLedger 每次超限即收敛（裁 1 条一份归档），归档按次多份——总量守恒是硬口径
    const archived = archiveFiles(tmp, "feedback");
    assert.ok(archived.length >= 1, `归档存在（${archived.length} 份）`);
    const archRows = archived.flatMap((f) => readLines(tmp, `archive/${f}`)).map((r) => r.text).sort();
    assert.deepEqual(archRows, ["f0", "f1", "f2", "f3", "f4"], "被裁 5 行全在归档，一条不丢");
    const state = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "ledger-state.json"), "utf8"));
    assert.equal(state["feedback.jsonl"].archivedTotal, 5, "累计归档记账");
    assert.ok(state["feedback.jsonl"].lastArchive.path.includes("archive/"), "最近归档路径可回溯");
    assert.equal(rows.length + archRows.length, 8, "守恒：账内+归档=裁前总数");
  } finally {
    delete process.env.WFP_LEDGER_MAX;
  }
});

test("归档有界：超 WFP_LEDGER_ARCHIVE_KEEP 删最旧，不把只增不删搬进 archive/", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "2";
  process.env.WFP_LEDGER_ARCHIVE_KEEP = "2";
  try {
    for (let round = 0; round < 4; round += 1) {
      appendLedger(tmp, "feedback.jsonl", { at: `2026-02-0${round * 2 + 1}`, text: `a${round}` });
      appendLedger(tmp, "feedback.jsonl", { at: `2026-02-0${round * 2 + 2}`, text: `b${round}` });
      appendLedger(tmp, "feedback.jsonl", { at: `2026-02-1${round}`, text: `c${round}` }); // 每轮触发一次收敛
    }
    const archived = archiveFiles(tmp, "feedback");
    assert.equal(archived.length, 2, `归档封顶 2 份（实际 ${archived.length}）`);
  } finally {
    delete process.env.WFP_LEDGER_MAX;
    delete process.env.WFP_LEDGER_ARCHIVE_KEEP;
  }
});

test("归档失败本轮不裁：数据安全优先，真账原样、note 如实", () => {
  const tmp = tmpRoot();
  for (let i = 0; i < 5; i += 1) appendLedger(tmp, "feedback.jsonl", { at: `2026-03-0${i + 1}`, text: `x${i}` });
  fs.writeFileSync(path.join(tmp, "stats", "archive"), "占位文件：mkdir 必败"); // 归档路径不可写
  const r = trimLedger(tmp, "feedback.jsonl", 2);
  assert.equal(r.trimmed, 0, "归档失败不裁");
  assert.match(r.note, /归档失败本轮不裁/);
  assert.equal(readLines(tmp, "feedback.jsonl").length, 5, "真账一行不动");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("WFP_LEDGER_ARCHIVE_KEEP=0 关闭归档：回到旧行为，无 archive/ 产生", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "2";
  process.env.WFP_LEDGER_ARCHIVE_KEEP = "0";
  try {
    for (let i = 0; i < 5; i += 1) appendLedger(tmp, "queries.jsonl", { q: `q${i}`, at: `2026-04-0${i + 1}` });
    assert.equal(readLines(tmp, "queries.jsonl").length, 2);
    assert.deepEqual(archiveFiles(tmp, "queries"), [], "归档关闭如实无文件");
  } finally {
    delete process.env.WFP_LEDGER_MAX;
    delete process.env.WFP_LEDGER_ARCHIVE_KEEP;
  }
});
