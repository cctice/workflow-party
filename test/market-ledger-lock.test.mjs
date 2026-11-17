// 台账写侧并发保护测试（维护心跳包·十三轮）：jsonl"单进程写"假设钉死。
//   ① 并发追加：两真实进程同时写同一本账，行一条不丢、无半行、全部 JSON 合法
//   ② 并发收敛：两进程同时 trim 同一本账，文件合法、行数不超封顶、顺序不乱
//   ③ 并发 recordInstall：seq 计算读→追加→折叠整段持锁，seq 不重复、归账不重不漏
//   ④ 陈锁接管：30s 前的残留锁不卡死后续写（崩溃残留自愈）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendLedger, trimLedger, recordInstall, withLedgerLock } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKET_URL = pathToFileURL(path.join(root, "scripts", "market.mjs")).href;

function tmpRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-ledger-lock-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.copyFileSync(path.join(root, "stats", "downloads.json"), path.join(tmp, "stats", "downloads.json"));
  return tmp;
}

async function runWorker(env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", env.WORKER], {
    env: { ...process.env, ...env },
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `worker ${env.WFP_TEST_TAG} 非零退出`);
}

const readRows = (tmp, file) =>
  fs.readFileSync(path.join(tmp, "stats", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("并发追加：两真实进程同写一本账，行一条不丢、无半行", async () => {
  const tmp = tmpRoot();
  const WORKER = `import { appendLedger } from ${JSON.stringify(MARKET_URL)};
const root = process.env.WFP_TEST_ROOT, tag = process.env.WFP_TEST_TAG;
for (let i = 0; i < 30; i++) appendLedger(root, "queries.jsonl", { q: tag + "-" + i, at: new Date().toISOString() });
`;
  await Promise.all([
    runWorker({ WORKER, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "A" }),
    runWorker({ WORKER, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "B" }),
  ]);
  const rows = readRows(tmp, "queries.jsonl");
  assert.equal(rows.length, 60, "两进程各 30 条一条不丢");
  const tags = new Set(rows.map((r) => r.q.split("-")[0]));
  assert.deepEqual([...tags].sort(), ["A", "B"]);
  assert.equal(new Set(rows.map((r) => r.q)).size, 60, "无重复行");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("并发收敛：两进程同时 trim 同一本账，文件合法、行数不超封顶", async () => {
  const tmp = tmpRoot();
  for (let i = 0; i < 120; i++) appendLedger(tmp, "queries.jsonl", { q: "q" + i, at: new Date().toISOString() });
  const WORKER = `import { trimLedger } from ${JSON.stringify(MARKET_URL)};
trimLedger(process.env.WFP_TEST_ROOT, "queries.jsonl", 50);
`;
  await Promise.all([
    runWorker({ WORKER, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "trimA" }),
    runWorker({ WORKER, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "trimB" }),
  ]);
  const rows = readRows(tmp, "queries.jsonl"); // 半行/坏行当场 JSON.parse 抛
  assert.ok(rows.length <= 50, `收敛后行数 ${rows.length} 不超封顶 50`);
  assert.ok(rows.length > 0, "不至于清空");
  const qNums = rows.map((r) => Number(r.q.slice(1)));
  for (let i = 1; i < qNums.length; i++) assert.ok(qNums[i] > qNums[i - 1], "保尾部最新且相对顺序不变");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("并发 recordInstall：seq 不重复、归账不重不漏", async () => {
  const tmp = tmpRoot();
  const WORKER = `import { recordInstall } from ${JSON.stringify(MARKET_URL)};
const r = recordInstall(process.env.WFP_TEST_ROOT, "kaleidosphere", { consumer: "worker-" + process.env.WFP_TEST_TAG });
if (!r) process.exit(3);
`;
  await Promise.all([
    runWorker({ WORKER, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "A" }),
    runWorker({ WORKER, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "B" }),
  ]);
  const events = readRows(tmp, "events.jsonl");
  const seqs = events.map((e) => e.seq);
  assert.equal(seqs.length, 2);
  assert.equal(new Set(seqs).size, 2, "两进程各记一条，seq 互不重复");
  const stats = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "downloads.json"), "utf8"));
  assert.equal(stats.foldedSeq, Math.max(...seqs), "折叠水位追平最大 seq");
  const bumped = Object.entries(stats.counts).filter(([k]) => k.startsWith("kaleidosphere@"));
  assert.equal(bumped.reduce((s, [, v]) => s + v, 0) - Object.entries(JSON.parse(fs.readFileSync(path.join(root, "stats", "downloads.json"), "utf8")).counts).filter(([k]) => k.startsWith("kaleidosphere@")).reduce((s, [, v]) => s + v, 0), 2, "两事件各归账一次，不重不漏");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("陈锁接管：超龄残留锁不卡死后续写", () => {
  const tmp = tmpRoot();
  const lockPath = path.join(tmp, "stats", ".ledger.lock");
  fs.writeFileSync(lockPath, "crashed");
  const stale = new Date(Date.now() - 31 * 1000);
  fs.utimesSync(lockPath, stale, stale); // 31s 前的崩溃残留
  const out = withLedgerLock(tmp, () => 42);
  assert.equal(out, 42, "超龄陈锁被接管，写路径照常完成");
  assert.ok(!fs.existsSync(lockPath), "接管后锁即释放");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── bumpDownloads 持锁（十四轮）：锁外最后一个读-改-写裸奔点收口 ─────────────
// 痛点（十三轮留题）：并发保护盖住了 append/trim/record/ingest，但 bump（downloads.json
// 读改写）仍在锁外——bump 与 ingest 并发 = 后写者整体覆盖前写者，丢 +N 的丢账。
test("并发 bump×ingest：downloads.json 不丢账（counts 守恒）", async () => {
  const tmp = tmpRoot();
  const before = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "downloads.json"), "utf8"));
  const base = before.counts["kaleidosphere@0.4.2"] ?? 0;
  const WORKER_BUMP = `import { bumpDownloads } from ${JSON.stringify(MARKET_URL)};
for (let i = 0; i < 20; i++) bumpDownloads(process.env.WFP_TEST_ROOT, "kaleidosphere", 1);
`;
  const WORKER_RECORD = `import { recordInstall } from ${JSON.stringify(MARKET_URL)};
for (let i = 0; i < 20; i++) recordInstall(process.env.WFP_TEST_ROOT, "kaleidosphere", { consumer: "c" });
`;
  await Promise.all([
    runWorker({ WORKER: WORKER_BUMP, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "bump" }),
    runWorker({ WORKER: WORKER_RECORD, WFP_TEST_ROOT: tmp, WFP_TEST_TAG: "record" }),
  ]);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, "stats", "downloads.json"), "utf8"));
  assert.equal(after.counts["kaleidosphere@0.4.2"], base + 40, "20 次 bump + 20 条事件归账一条不丢");
  fs.rmSync(tmp, { recursive: true, force: true });
});
