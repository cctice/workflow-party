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

// ── 归档消费面（十四轮）：归档文件本身有人看，不再人肉 grep ──────────────────
import { archiveIndex } from "../scripts/market.mjs";

test("archive 清单面：trim 真产归档后 archiveIndex 逐份可读（账名/行数/首末时间）", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "2";
  try {
    for (let i = 1; i <= 5; i += 1) logQuery(tmp, `审计关键词 q${i}`);
    const idx = archiveIndex(tmp);
    // 封顶后每次 append 都触发收敛：5 条封顶 2 → 3 次裁剪各落一份归档、每份 1 行
    assert.equal(idx.files.length, 3, "逐次收敛逐次落档");
    assert.ok(idx.files.every((f) => f.ledger === "queries"), "账名从前缀归位");
    assert.equal(idx.files.reduce((s2, f) => s2 + f.rows, 0), 3, "被裁 3 行全在档");
    assert.ok(idx.files.every((f) => f.badRows === 0));
    assert.ok(idx.files.every((f) => f.firstAt && f.lastAt && f.firstAt <= f.lastAt), "首末行时间随行");
    assert.ok(idx.files.every((f) => f.bytes > 0));
  } finally {
    delete process.env.WFP_LEDGER_MAX;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("archive --grep：跨归档检索命中行带出处；不命中如实报空；--ledger 过滤与未知名拒绝", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "2";
  try {
    for (let i = 1; i <= 4; i += 1) logQuery(tmp, `needle-a q${i}`);
    const hit = archiveIndex(tmp, { grep: "NEEDLE-A" }); // 大小写不敏感
    assert.equal(hit.matches.length, 2, "被裁 2 行命中");
    assert.ok(hit.matches.every((m) => m.file.startsWith("queries-") && m.line.includes("needle-a")), "命中行带出处（哪份归档）");
    const miss = archiveIndex(tmp, { grep: "不存在的水词" });
    assert.equal(miss.matches.length, 0);
    assert.match(miss.note, /no archived rows match/);
    const only = archiveIndex(tmp, { ledger: "queries" });
    assert.equal(only.files.length, 2);
    assert.equal(archiveIndex(tmp, { ledger: "events" }).files.length, 0, "他账如实空");
    assert.throws(() => archiveIndex(tmp, { ledger: "nope" }), /unknown ledger/);
  } finally {
    delete process.env.WFP_LEDGER_MAX;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("archive 坏行不连坐 + 空目录如实：badRows 计数、其余行照常可审计", () => {
  const tmp = tmpRoot();
  const dir = path.join(tmp, "stats", "archive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "feedback-2026-01-02T00-00-00-000Z.jsonl"),
    JSON.stringify({ at: "2026-01-02T00:00:00Z", plugin: "x", text: "好行" }) + "\n{broken\n");
  const idx = archiveIndex(tmp);
  assert.equal(idx.files.length, 1);
  assert.equal(idx.files[0].rows, 2);
  assert.equal(idx.files[0].badRows, 1, "坏行如实计数");
  assert.equal(idx.files[0].lastAt, "2026-01-02T00:00:00Z", "好行时间照常可读");
  const empty = tmpRoot();
  assert.equal(archiveIndex(empty).files.length, 0, "无 archive/ 目录如实空");
  assert.match(archiveIndex(empty).note, /no archives yet/);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

// ── 跨账+档一体化（十五轮）：审计口径不再"归档一套、在账一套" ────────────────
test("archive --grep --live：在账明细并入检索口径，live 在前归档在后、出处分家、账可过滤", () => {
  const tmp = tmpRoot();
  process.env.WFP_LEDGER_MAX = "2";
  try {
    // 5 条含 needle 的查询：封顶 2 → 前 3 条被裁进归档、最新 2 条留在账
    for (let i = 1; i <= 5; i += 1) logQuery(tmp, `一体化 needle q${i}`);
    const hit = archiveIndex(tmp, { grep: "needle", includeLive: true });
    assert.equal(hit.matches.length, 5, "在账 2 行 + 归档 3 行一体化全命中");
    assert.deepEqual(hit.matches.map((m) => m.source), ["live", "live", "archive", "archive", "archive"], "live 在前（最新段），归档随后");
    assert.ok(hit.matches[0].file === "queries.jsonl" && hit.matches[2].file.startsWith("queries-"), "出处分家：在账=账文件，归档=归档文件");
    assert.deepEqual(hit.hitsBySource, { live: 2, archive: 3 }, "分家计数可对账");
    assert.ok(hit.liveFiles?.length === 1 && hit.liveFiles[0].file === "queries.jsonl", "在账清单面随行（未开张的账如实跳过不冒充空文件）");
    assert.equal(hit.liveFiles[0].rows, 2, "在账行数如实");
    // 不加 --live 的老口径分毫不动（back-compat 钉死）
    const archOnly = archiveIndex(tmp, { grep: "needle" });
    assert.equal(archOnly.matches.length, 3);
    assert.ok(archOnly.matches.every((m) => m.file.startsWith("queries-")));
    assert.equal(archOnly.liveFiles, undefined, "live 面不冒出");
    // --ledger 过滤对 live 同样生效；live+grep 不命中时报空话术区分口径
    const onlyLive = archiveIndex(tmp, { grep: "needle", includeLive: true, ledger: "queries" });
    assert.equal(onlyLive.matches.length, 5);
    const missAll = archiveIndex(tmp, { grep: "不存在的水词", includeLive: true });
    assert.equal(missAll.matches.length, 0);
    assert.match(missAll.note, /在账\+归档/);
    assert.match(archiveIndex(tmp, { grep: "不存在的水词" }).note, /no archived rows match/, "老口径话术保留");
  } finally {
    delete process.env.WFP_LEDGER_MAX;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 检索模式深化（十六轮留题兑现）：--grep 子串 → --regex 正则 / --and 多词 AND ──────
test("archive --grep --and：多词全子串、与顺序无关、缺一词不命中；--grep --regex：正则解释、坏正则报错不静默", () => {
  const tmp = tmpRoot();
  try {
    logQuery(tmp, "alpha 报错 beta");      // 两词都在（顺序 A）
    logQuery(tmp, "beta alpha 提醒");      // 两词都在（顺序 B——AND 与顺序无关）
    logQuery(tmp, "alpha 单词");           // 只有 alpha
    const dir = path.join(tmp, "stats", "archive");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "queries-2026-01-01T00-00-00-000Z.jsonl"),
      JSON.stringify({ at: "2026-01-01T00:00:00Z", q: "alpha beta gamma 归档行" }) + "\n");

    // and：在账+归档全纳入，顺序无关，缺词不命中
    const and = archiveIndex(tmp, { grep: "alpha beta", mode: "and", includeLive: true });
    assert.equal(and.mode, "and", "模式随行可观测");
    assert.equal(and.matches.length, 3, "在账 2（两序皆有）+ 归档 1");
    const andMiss = archiveIndex(tmp, { grep: "alpha 报错 gamma", mode: "and", includeLive: true });
    assert.equal(andMiss.matches.length, 0, "缺一词即不命中（AND 语义不是 OR）");
    // 大小写不敏感同 substr 口径
    const ci = archiveIndex(tmp, { grep: "ALPHA beta", mode: "and" });
    assert.equal(ci.matches.length, 1, "大小写不敏感");

    // regex：跨行正则、大小写不敏感、顺序敏感（alpha 后必须跟 beta|gamma——
    // 与 AND 的差异点：AND 无序、regex 由模式自己定序）；坏正则如实报错
    const re = archiveIndex(tmp, { grep: "alpha.*(beta|gamma)", mode: "regex", includeLive: true });
    assert.equal(re.mode, "regex");
    assert.equal(re.matches.length, 2, "在账 1（'beta alpha' 顺序不符不命中——regex 序敏感）+ 归档 1");
    assert.throws(() => archiveIndex(tmp, { grep: "alpha(", mode: "regex" }), /invalid regex/, "坏正则报错不静默降级子串");

    // back-compat：默认 substr 老口径分毫不动（无 mode 字段、整句子串语义）
    const legacy = archiveIndex(tmp, { grep: "alpha beta", includeLive: true });
    assert.equal(legacy.mode, undefined, "substr 默认不标（老消费方零 churn）");
    assert.equal(legacy.matches.length, 1, "整句 'alpha beta' 只子串命中归档那一行");
    assert.throws(() => archiveIndex(tmp, { mode: "fuzzy", grep: "x" }), /unknown grep mode/, "未知模式报错不猜");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("archive 检索修饰卫兵：--regex 与 --and 互斥、修饰悬空（无 --grep）报错（真进程实证）", () => {
  const tmp2 = tmpRoot(); // loadCatalog 先于卫兵跑：临时根带真清单形态防 ENOENT 噪音
  const run = (args) => {
    try {
      const stdout = execFileSync("node", [path.join(root, "scripts", "market.mjs"), "archive", ...args], {
        encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp2 },
      });
      return { code: 0, out: stdout };
    } catch (err) {
      return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };
  try {
    const both = run(["--grep", "x", "--regex", "--and"]);
    assert.equal(both.code, 1);
    assert.match(both.out, /互斥/);
    const dangling = run(["--regex"]);
    assert.equal(dangling.code, 1);
    assert.match(dangling.out, /需与 --grep/);
    const badRe = run(["--grep", "x(", "--regex"]);
    assert.equal(badRe.code, 1);
    assert.match(badRe.out, /invalid regex/);
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

// ---- 十七轮：market ledger 快查（report 内嵌面的单独入口） ----
test("market ledger：三本账点名快查，--json 与 report.ledgers 同源同值（真进程实证）", async () => {
  const tmp = tmpRoot();
  try {
    // 造点真账：一次 record + 一次 feedback + 一次搜索热度，行数/归档面随行
    execFileSync("node", [path.join(root, "scripts", "market.mjs"), "record", "kaleidosphere"],
      { encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp } });
    const run = (args) => execFileSync("node", [path.join(root, "scripts", "market.mjs"), ...args],
      { encoding: "utf8", env: { ...process.env, WFP_ROOT: tmp } });
    const text = run(["ledger"]);
    assert.match(text, /events\.jsonl\s+1 行 \/ \d+ B\s+封顶 5000\s+累计裁 0\s+累计归档 0/);
    assert.ok(["events.jsonl", "feedback.jsonl", "queries.jsonl"].every((f) => text.includes(f)), "三本账逐一点名");
    // --json 口径与 report.ledgers 同源（ledgerHealth 单一真源，两个入口零漂移）
    const { buildReport, loadCatalog } = await import("../scripts/market.mjs");
    const quick = JSON.parse(run(["ledger", "--json"]));
    const embedded = buildReport(loadCatalog(tmp), tmp).ledgers;
    assert.deepEqual(quick, embedded, "快查面 ≡ report 内嵌面（同函数产出的两张嘴说同一话）");
    assert.equal(quick.find((l) => l.file === "events.jsonl").lines, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
