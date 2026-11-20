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
import { loadCatalog, buildReport, weeklyTrend, isoWeekKey, exportReport } from "../scripts/market.mjs";

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
  // 周锚定（十三轮修）：相对天数跨 ISO 周界漂移（测试写于周日、周一跑就挂）——
  // 一律以本周周一 00:00Z 为锚，偏移整周+周内天数，事件落哪一周与跑测日无关。
  const mondayUTC = (weeksAgo) => {
    const d = new Date(now);
    const day = (d.getUTCDay() + 6) % 7; // 周一=0
    d.setUTCDate(d.getUTCDate() - day - weeksAgo * 7);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  };
  const inWeek = (weeksAgo, dayOffset) => new Date(mondayUTC(weeksAgo) + dayOffset * 86400000).toISOString();
  // 上上周 2 安装 1 反馈；上周 2 安装 2 搜索；当周（partial）1 搜索
  fs.writeFileSync(path.join(root, "stats", "events.jsonl"), [
    JSON.stringify({ seq: 1, type: "install", plugin: "p", version: "1", at: inWeek(2, 1) }),
    JSON.stringify({ seq: 2, type: "install", plugin: "p", version: "1", at: inWeek(2, 2) }),
    JSON.stringify({ seq: 3, type: "install", plugin: "p", version: "1", at: inWeek(1, 1) }),
    JSON.stringify({ seq: 4, type: "install", plugin: "p", version: "1", at: inWeek(1, 2) }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(root, "stats", "feedback.jsonl"),
    JSON.stringify({ at: inWeek(2, 3), plugin: "p@1", kind: "bug", text: "x" }) + "\n");
  fs.writeFileSync(path.join(root, "stats", "queries.jsonl"), [
    JSON.stringify({ q: "gatt", at: inWeek(1, 1) }),
    JSON.stringify({ q: "gatt", at: inWeek(1, 3) }),
    JSON.stringify({ q: "afk", at: inWeek(0, 0) }),
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

// ---- 十七轮：报表导出面（--export CSV/JSON 落盘） ----

test("exportReport：CSV=榜单表（RFC4180 转义），JSON=完整报表与 --json 同源同值", () => {
  const tmp = tmpRoot({ "kfc-plugin@0.1.1": 7, "kaleidosphere@0.4.2": 3 });
  const report = buildReport(loadCatalog(tmp), tmp);
  // CSV：榜单表逐行对账（含逗号/引号字段的转义口径由坏字符用例钉死）
  const csv = exportReport(report, path.join(tmp, "report.csv"));
  assert.equal(csv.format, "csv");
  assert.equal(csv.rows, report.leaderboard.length);
  const lines = fs.readFileSync(csv.path, "utf8").trimEnd().split("\n");
  assert.equal(lines[0], "rank,plugin,downloads,share,versions,bundled");
  assert.equal(lines[1], "1,kfc-plugin@0.1.1,7,70,0.1.1:7,false");
  assert.ok(lines[3].endsWith(",true"), "bundled 列如实带标");
  // CSV 解析回来行数守恒（表头+3 条目）
  assert.equal(lines.length, report.leaderboard.length + 1);
  // JSON：完整报表对象与 buildReport 结果深相等（与 --json stdout 同源同值）
  const json = exportReport(report, path.join(tmp, "nested", "dir", "report.json"));
  assert.equal(json.format, "json");
  assert.deepEqual(JSON.parse(fs.readFileSync(json.path, "utf8")), report, "JSON 导出=完整报表口径，不多不少");
  // 落盘原子性约定：不留 .tmp 残件
  assert.ok(!fs.existsSync(`${csv.path}.tmp`) && !fs.existsSync(`${json.path}.tmp`));
  assert.ok(json.path.includes(path.join("nested", "dir")), "父目录不存在自动建");
  // RFC4180 转义：合成带逗号/引号的字段（真实清单不会有，但导出器不替数据把关）
  const nasty = exportReport(
    { total: 1, zeroDownload: [], leaderboard: [{ rank: 1, plugin: 'p"1,x', downloads: 1, share: 100, versions: ["1,0:1"], bundled: false }], heat: [], trend: null, ledgers: [] },
    path.join(tmp, "nasty.csv"),
  );
  const nastyLines = fs.readFileSync(nasty.path, "utf8").trimEnd().split("\n");
  assert.equal(nastyLines[1], '1,"p""1,x",1,100,"1,0:1",false', "引号 doubling、含逗号字段加壳");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("exportReport：未知/无扩展名宁红勿默（exit 1 指路），不猜默认格式", () => {
  const tmp = tmpRoot({});
  const report = buildReport(loadCatalog(tmp), tmp);
  assert.throws(() => exportReport(report, path.join(tmp, "out.txt")), /\.csv（榜单表）\/ \.json（完整报表）/);
  assert.throws(() => exportReport(report, path.join(tmp, "noext")), /只支持 \.csv/);
  assert.ok(!fs.existsSync(path.join(tmp, "out.txt")), "拒绝时不落半份文件");
  // CLI 真进程：坏扩展名 exit 1 + stderr 指路（宁红勿默的进程面）
  let cli = { code: 0, out: "" };
  try {
    execFileSync("node", [path.join(root, "scripts", "market.mjs"), "report", "--export", path.join(tmp, "bad.txt")],
      { encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp } });
  } catch (err) {
    cli = { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
  assert.equal(cli.code, 1, "坏扩展名 CLI exit 1");
  assert.match(cli.out, /宁报错不猜默认/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
