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
import { loadCatalog, buildReport } from "../scripts/market.mjs";

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
