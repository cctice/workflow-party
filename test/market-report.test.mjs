// 聚合报表测试（维护心跳包·九轮）：发现机制有了，运营视角的"什么被需要"看不到。
//   ① 榜单：rank/downloads 降序、share 求和≈100%、bundled 条目如实带标
//   ② 零下载点名：不灌水，没下载就是没下载
//   ③ 版本摊薄：counts 里同插件多版本 key → versions 逐版本展开
//   ④ 搜索热度：CLI search 落 queries.jsonl（WFP_ROOT 临时根），report 聚合 top 查询+冠军命中
//   ⑤ 无查询记录如实报空（数据面起步，不编造热度）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCatalog, buildReport, weeklyTrend, isoWeekKey } from "../scripts/market.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot(seedCounts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfp-report-"));
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "stats"), { recursive: true });
  fs.copyFileSync(path.join(root, ".claude-plugin", "marketplace.json"), path.join(tmp, ".claude-plugin", "marketplace.json"));
  fs.writeFileSync(path.join(tmp, "stats", "downloads.json"), JSON.stringify({ schema: 1, counts: seedCounts }, null, 2));
  return tmp;
}

test("榜单：降序+份额+ bundled 如实带标，零下载点名不灌水", () => {
  const tmp = tmpRoot({ "kfc-plugin@0.1.1": 7, "kaleidosphere@0.4.2": 3 });
  const report = buildReport(loadCatalog(tmp), tmp);
  assert.equal(report.total, 10);
  assert.equal(report.leaderboard[0].plugin, "kfc-plugin@0.1.1");
  assert.equal(report.leaderboard[0].share, 70);
  assert.equal(report.leaderboard.find((r) => r.plugin.startsWith("afk")).bundled, true);
  assert.deepEqual(report.zeroDownload, ["afk@0.1.0"], "bundled 零下载如实点名");
  const shareSum = report.leaderboard.reduce((s, r) => s + r.share, 0);
  assert.ok(shareSum >= 99 && shareSum <= 101, `份额求和 ${shareSum} 应≈100`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("版本摊薄：同插件多版本 counts key 逐版本展开", () => {
  const tmp = tmpRoot({ "kaleidosphere@0.4.1": 2, "kaleidosphere@0.4.2": 5 });
  const row = buildReport(loadCatalog(tmp), tmp).leaderboard.find((r) => r.plugin === "kaleidosphere@0.4.2");
  assert.deepEqual(row.versions, ["0.4.1:2", "0.4.2:5"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("搜索热度：search 落账（WFP_ROOT 临时根），report 聚合 top 查询+冠军命中", () => {
  const tmp = tmpRoot({});
  const run = (args) => execFileSync(process.execPath, [path.join(root, "scripts", "market.mjs"), ...args],
    { encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp } });
  run(["search", "kfc"]);
  run(["search", "kfc"]);
  run(["search", "kaleidosphere"]);
  const report = buildReport(loadCatalog(tmp), tmp, { topN: 2 });
  assert.equal(report.heat[0].query, "kfc");
  assert.equal(report.heat[0].searches, 2);
  assert.equal(report.heat[0].topHit, "kfc-plugin", "冠军命中=该查询相关度第一名");
  assert.equal(report.heat[1].searches, 1);
  assert.ok(!fs.existsSync(path.join(root, "stats", "queries.jsonl")), "真仓 queries 账不被冒烟污染");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("无查询记录如实报空——热度数据面起步，不编造", () => {
  const tmp = tmpRoot({});
  const report = buildReport(loadCatalog(tmp), tmp);
  assert.deepEqual(report.heat, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 十一轮：三本账时间维度（周趋势/环比） ----

test("isoWeekKey：ISO 周口径（周一之始，跨年周不慌）", () => {
  assert.equal(isoWeekKey(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(isoWeekKey(new Date("2026-01-05T00:00:00Z")), "2026-W02"); // 周一
  assert.equal(isoWeekKey(new Date("2026-01-04T23:59:59Z")), "2026-W01"); // 周日仍属上周
});

test("weeklyTrend：三本账按周分桶+环比；前周为零如实 null 不编 ∞%", () => {
  const root = tmpRoot({});
  fs.mkdirSync(path.join(root, "stats"), { recursive: true });
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  // 上上周 2 安装 1 反馈；上周 4 安装 2 搜索；当周（partial）1 搜索
  fs.writeFileSync(path.join(root, "stats", "events.jsonl"), [
    JSON.stringify({ seq: 1, type: "install", plugin: "p", version: "1", at: daysAgo(15) }),
    JSON.stringify({ seq: 2, type: "install", plugin: "p", version: "1", at: daysAgo(14) }),
    JSON.stringify({ seq: 3, type: "install", plugin: "p", version: "1", at: daysAgo(8) }),
    JSON.stringify({ seq: 4, type: "install", plugin: "p", version: "1", at: daysAgo(7) }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(root, "stats", "feedback.jsonl"),
    JSON.stringify({ at: daysAgo(15), plugin: "p@1", kind: "bug", text: "x" }) + "\n");
  fs.writeFileSync(path.join(root, "stats", "queries.jsonl"), [
    JSON.stringify({ q: "gatt", at: daysAgo(8) }),
    JSON.stringify({ q: "gatt", at: daysAgo(7) }),
    JSON.stringify({ q: "afk", at: daysAgo(1) }),
  ].join("\n") + "\n");

  const t = weeklyTrend(root, 4);
  assert.equal(t.series.length, 4);
  assert.equal(t.partial, true, "当周进行中");
  // 桶对得上：上周 installs=2 searches=2；上上周 installs=2 feedback=1
  const lastFull = t.series[t.series.length - 2];
  assert.equal(lastFull.installs, 2);
  assert.equal(lastFull.searches, 2);
  const prevFull = t.series[t.series.length - 3];
  assert.equal(prevFull.installs, 2);
  assert.equal(prevFull.feedback, 1);
  // 环比：installs 2 vs 2 = 0%；feedback 0 vs 1 = -100%；searches 2 vs 0 = null（前周零不编）
  assert.equal(t.wow.installs, 0);
  assert.equal(t.wow.feedback, -100);
  assert.equal(t.wow.searches, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("report 面带 trend（buildReport 集成）；空账周不断档全 0", () => {
  const root = tmpRoot({});
  fs.mkdirSync(path.join(root, "stats"), { recursive: true });
  // 空三本账：周序列仍连续、全 0
  const t = weeklyTrend(root, 3);
  assert.equal(t.series.length, 3);
  assert.ok(t.series.every((w) => w.installs === 0 && w.feedback === 0 && w.searches === 0));
  assert.ok(t.wow, '周数够即出 wow 面（差值全 null 如实不编）');
  assert.equal(t.wow.installs, null, '前周为零差值 null（不编 ∞%）');
  // buildReport 集成面：trend 挂进报表
  const report = buildReport(loadCatalog(root), root);
  assert.ok(report.trend && report.trend.series.length === 4, 'report 应带 trend 面（默认 4 周）');
  fs.rmSync(root, { recursive: true, force: true });
});
