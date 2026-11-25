#!/usr/bin/env node
// market.mjs —— 市场发现机制 CLI（维护心跳包·五轮：搜索/分类/下载量从零起步）
//
// 背景：市场此前只有"清单存在性"，没有任何发现面——想找插件只能肉眼读 JSON；
// 分类过滤、关键词搜索、下载量排序全缺。
//
// 用法：
//   node scripts/market.mjs list [--category developer-tools] [--sort name|downloads] [--json]
//   node scripts/market.mjs search <关键词...> [--json]     # 分词+相关度评分（name>category>description，多词 AND）
//   node scripts/market.mjs info <name> [--json]            # 条目 + 下载量 + 来源
//   node scripts/market.mjs stats [--json]                  # 下载量台账全量
//   node scripts/market.mjs bump <name> [--by N]            # 安装/发放回填下载量（默认 +1，手工形态）
//   node scripts/market.mjs record <name> [--consumer ks]   # 安装事件回传（九轮）：追加 events.jsonl 并当场归账
//   node scripts/market.mjs ingest                          # 归账待处理事件（seq 水位幂等，重跑不多记）
//   node scripts/market.mjs feedback <name> <text> [--kind bug|idea|review]  # 反馈通道（九轮）：脱敏+本地留档+issue 预填
//   node scripts/market.mjs report [--json] [--export <file.csv|file.json>]  # 聚合报表（九轮）：下载量榜/份额/搜索热度
//                                                           # 导出面（十七轮）：JSON=完整报表口径，CSV=榜单表（热度/趋势/台账健康走 JSON）
//   node scripts/market.mjs ledger [--json]                 # 台账快查（十七轮）：三本账行数/封顶/累计裁剪/累计归档点名——report 内嵌面的单独入口
//   node scripts/market.mjs doctor [--json]                 # 数据面体检（二十二轮）：键覆盖/坏行/事件序列/水位/账实相符——全程只读，红则 exit 1 逐条点名
//   node scripts/market.mjs trim [--max N]                  # 手动收敛三本账（十二轮）：被裁行先归档
//   node scripts/market.mjs archive [--ledger events|feedback|queries] [--grep <text>] [--regex] [--and] [--live] [--limit N] [--json]
//                                                           # 归档消费面（十四轮）：--grep 加 --live 跨账+档一体化检索（十五轮）；
//                                                           # --regex/--and 检索模式修饰（十六轮）：正则 / 多词 AND
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.WFP_ROOT ? path.resolve(process.env.WFP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 分类归一：大小写/空格-连字符 归一（"Developer Tools" === "developer-tools"） */
export function normalizeCategory(c) {
  return String(c || "").trim().toLowerCase().replace(/\s+/g, "-");
}

/** 读目录：市场索引 + 下载台账（注入 repoRoot 便于测试用临时根） */
export function loadCatalog(repoRoot = root) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  let downloads = {};
  try {
    downloads = JSON.parse(fs.readFileSync(path.join(repoRoot, "stats", "downloads.json"), "utf8")).counts || {};
  } catch { /* 台账未建：下载量按 0，info/stats 如实报 */ }
  return {
    entries: index.plugins.map((p) => ({
      ...p,
      category: normalizeCategory(p.category),
      downloads: downloads[`${p.name}@${p.version}`] ?? 0,
    })),
    downloadsRaw: downloads,
  };
}

/** 关键词搜索：分词 + 相关度评分（八轮升级，替代纯子串匹配）
 *
 * 评分模型（可解释、零依赖）：
 *   - 查询按空白分词，多 token 是 AND 语义（每个 token 都要有贡献才命中）；
 *   - 字段权重 name(6) > category(4) > description(2)——"查名字"最该排前；
 *   - 每字段两种贡献：整词命中（词边界全等）拿满权重，子串命中拿一半；
 *   - 罕见 token 信息量更高：命中同一 token 的插件越少，贡献 × 逆文档频放大；
 *   - 相关度优先，下载量只做同分 tie-break——命中质量不再被热度淹没。
 */
const FIELD_WEIGHTS = [
  ["name", 6],
  ["category", 4],
  ["description", 2],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tokenHitsField(text, token) {
  if (!text) return 0; // 0=不命中 1=子串 2=整词
  return new RegExp(`\\b${escapeRe(token)}\\b`).test(text) ? 2 : text.includes(token) ? 1 : 0;
}

/** 单条目打分：任一 token 零贡献即出局（AND 语义），返回 {score, fields} 或 null */
export function scoreEntry(entry, tokens, idf) {
  let score = 0;
  const fields = new Set();
  for (const token of tokens) {
    let tokenScore = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const level = tokenHitsField(String(entry[field] || "").toLowerCase(), token);
      if (level > 0) {
        tokenScore = Math.max(tokenScore, level === 2 ? weight : weight / 2);
        fields.add(field);
      }
    }
    if (tokenScore === 0) return null;
    score += tokenScore * (idf.get(token) ?? 1);
  }
  return { score: Math.round(score * 100) / 100, fields: [...fields] };
}

/** 关键词搜索：分词相关度排序（同分按下载量/名称 tie-break），结果携带 score/fields */
export function searchPlugins(catalog, query) {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  // 逆文档频：命中插件少的 token 更值钱（log 缩放；零命中 token idf=1，反正过不了 AND 门）
  const total = Math.max(catalog.entries.length, 1);
  const idf = new Map(
    tokens.map((t) => {
      const df = catalog.entries.filter((e) =>
        FIELD_WEIGHTS.some(([f]) => tokenHitsField(String(e[f] || "").toLowerCase(), t) > 0)
      ).length;
      return [t, df === 0 ? 1 : 1 + Math.log(total / df)];
    })
  );
  return catalog.entries
    .map((entry) => {
      const s = scoreEntry(entry, tokens, idf);
      return s ? { ...entry, score: s.score, fields: s.fields } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || cmpDownloads(a, b));
}

const cmpDownloads = (a, b) => (b.downloads - a.downloads) || a.name.localeCompare(b.name);

/** 列表：分类过滤 + 排序（downloads 降序默认；name 按字典序） */
export function listPlugins(catalog, { category, sort = "downloads" } = {}) {
  let entries = [...catalog.entries];
  if (category) entries = entries.filter((p) => p.category === normalizeCategory(category));
  entries.sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name) : cmpDownloads);
  return entries;
}

/** 回填下载量：+by（默认 1），同步 updatedAt；返回新值（未知名 → null）
 *  （十四轮）downloads.json 读-改-写整段持台账锁：与 ingest/record 同一把锁，
 *  bump 与事件归账并发不再后写者整体覆盖前写者（丢 +N 的丢账）。 */
export function bumpDownloads(repoRoot, name, by = 1) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = index.plugins.find((p) => p.name === name);
  if (!entry) return null;
  return withLedgerLock(repoRoot, () => {
    const statsPath = path.join(repoRoot, "stats", "downloads.json");
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    const key = `${entry.name}@${entry.version}`;
    stats.counts[key] = (stats.counts[key] ?? 0) + by;
    stats.updatedAt = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.dirname(statsPath), { recursive: true });
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2) + "\n");
    return stats.counts[key];
  });
}

// ---- 安装事件回传通道（九轮）----
// 痛点：下载量台账此前只能 `bump` 手填——发现机制的数据面是壳，没有真实安装事件。
// 现在安装侧（如 ks market install 落位后）经 record 追加一条事件到 stats/events.jsonl，
// ingest 按 seq 水位折叠进 counts（每条事件只记一次账，重跑幂等）；bump 保留为
// 手工回填形态（历史发放），事件账与手工账同仓不同源，台账 note 如实标注混合。

const eventsPath = (repoRoot) => path.join(repoRoot, "stats", "events.jsonl");

function readEventLines(repoRoot) {
  try {
    return fs.readFileSync(eventsPath(repoRoot), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; } // 通道未开张：零事件，如实
}

/** 安装事件落通道：校验插件在场（版本不跟即拒——不替人编造），seq 单调，当场归账。
 *  seq 计算读→追加→折叠整段持台账锁（十三轮）：两进程同时 record 不再撞出重复 seq。 */
export function recordInstall(repoRoot, name, { consumer = "unknown", version } = {}) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = index.plugins.find((p) => p.name === name);
  if (!entry) return null;
  if (version && version !== entry.version) {
    const err = new Error(`版本不符：事件 ${version} ≠ 市场当前 ${entry.version}`);
    err.code = "VERSION_MISMATCH";
    throw err;
  }
  return withLedgerLock(repoRoot, () => {
    const events = readEventLines(repoRoot);
    const seq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
    const event = { seq, type: "install", plugin: entry.name, version: entry.version, consumer, at: new Date().toISOString() };
    // 有界追加（十二轮）：未归账（seq > 折叠水位）的事件永不裁——账可瘦，未归账一条不丢
    const watermark = JSON.parse(fs.readFileSync(path.join(repoRoot, "stats", "downloads.json"), "utf8")).foldedSeq ?? 0;
    const p = path.join(repoRoot, "stats", "events.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(event) + "\n");
    const folded = ingestEventsUnlocked(repoRoot);
    return { event, folded };
  });
}

/** 折叠事件进下载台账：只记 seq > 水位的事件，返回本次归账条数（幂等重跑=0）。
 *  公开形态持台账锁（十三轮）；recordInstall 锁内复用 Unlocked 形态。 */
export function ingestEvents(repoRoot) {
  return withLedgerLock(repoRoot, () => ingestEventsUnlocked(repoRoot));
}

function ingestEventsUnlocked(repoRoot) {
  const statsPath = path.join(repoRoot, "stats", "downloads.json");
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
  const watermark = stats.foldedSeq ?? 0;
  const pending = readEventLines(repoRoot).filter((e) => (e.seq || 0) > watermark);
  for (const e of pending) {
    if (e.type !== "install") continue; // 通道只认安装事件，别的类型如实不动账
    const key = `${e.plugin}@${e.version}`;
    stats.counts[key] = (stats.counts[key] ?? 0) + 1;
    stats.foldedSeq = e.seq;
  }
  if (pending.length > 0) {
    stats.updatedAt = new Date().toISOString().slice(0, 10);
    stats.eventLedger = { foldedSeq: stats.foldedSeq, foldedAt: new Date().toISOString() };
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2) + "\n");
  }
  return pending.filter((e) => e.type === "install").length;
}

// ---- 反馈通道（九轮）：gatt 仓 issue 预填先例的市场版 ----
// 脱敏（邮箱/绝对路径/长十六进制串即令牌形态）→ 本地留档 stats/feedback.jsonl →
// 打印 GitHub issue 预填 URL（上架当天反馈即有去处，不用先建服务）。

const REDACTIONS = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  [/\/(?:Users|home)\/[\w.\/-]+/g, "[path]"],
  [/\b[0-9a-f]{16,}\b/gi, "[token]"],
];

export function redactText(text) {
  return REDACTIONS.reduce((t, [re, tag]) => t.replace(re, tag), String(text || ""));
}

/** 反馈三件套：脱敏正文 + 本地留档 + issue 预填 URL（未知名 → null） */
export function submitFeedback(repoRoot, name, text, { kind = "review" } = {}) {
  const index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = index.plugins.find((p) => p.name === name);
  if (!entry) return null;
  const record = {
    at: new Date().toISOString(),
    plugin: `${entry.name}@${entry.version}`,
    kind,
    text: redactText(text),
  };
  appendLedger(repoRoot, "feedback.jsonl", record); // 有界追加（十二轮）
  const title = `[feedback][${kind}] ${entry.name}@${entry.version}`;
  const body = [`插件：${entry.name}@${entry.version}`, `类别：${kind}`, "", "反馈内容（已自动脱敏）：", record.text].join("\n");
  const url = `https://github.com/cctice/workflow-party/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return { record, url };
}

// ---- 聚合报表（九轮）：下载量/搜索热度从台账到运营视角 ----
// 痛点：发现机制有了，但"什么被需要"看不到——榜单/份额/零下载如实点名。
// 搜索热度：CLI search 每次落 stats/queries.jsonl（WFP_ROOT 注入下写临时根），
// report 聚合 top 查询与每查询的冠军插件。

const queriesPath = (repoRoot) => path.join(repoRoot, "stats", "queries.jsonl");

// ---- 台账自治（十二轮）：三本账 jsonl 从"只增不删"变"封顶收敛" ----
// 痛点：events/feedback/queries 三本账 appendFileSync 只增不删——记多少涨多少，
// 读侧（record 的 seq 扫描/报表聚合）跟着无限涨。自治口径：
//   - 每本账封顶 WFP_LEDGER_MAX（默认 5000 条，0=关闭自治），写路径超限即收敛保最新；
//   - events.jsonl 的保护谓词：seq > 折叠水位的事件（未归账）永不裁——账可以瘦，
//     一条未归账的安装事件都不能丢；
//   - 收敛原子写（tmp+rename），裁了多少记 stats/ledger-state.json（可观测面），
//     report 面如实展示每本账行数/封顶/累计裁剪。
const LEDGERS = ["events.jsonl", "feedback.jsonl", "queries.jsonl"];

// ---- tests 计数单一真源（十四轮）：README 徽章 / site api / 对账门同源 ----
// 痛点（十三轮留题）：tests 计数口径散落三处各数各的（sync-badges 本地函数、
// manifest-sync 门内联重算、site 静态面若内嵌即第四处）——口径一多必漂。
// 统一收口在此：test/*.test.mjs 顶层 test() 静态声明计数（与门同逻辑）。
export function declaredTests(repoRoot) {
  const dir = path.join(repoRoot, "test");
  let declared = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));
  } catch {
    return 0; // 无 test/ 目录（演练临时根）：如实零声明
  }
  for (const file of files) {
    declared += (fs.readFileSync(path.join(dir, file), "utf8").match(/^test\(/gm) || []).length;
  }
  return declared;
}

export function ledgerMax() {
  const n = Number(process.env.WFP_LEDGER_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5000;
}

// ---- 归档面（十三轮）：封顶前的历史明细可再审计 ----
// 痛点（十二轮留题）：自治有了封顶，但被裁行直接丢弃——counts 聚合还在，
// 明细行没了（谁装的/搜了什么/反馈原文），"审计"只剩聚合口径。
// 口径：trim 被裁行先导出 stats/archive/<账名前缀>-<UTC 时间戳>.jsonl；
//   - 归档失败本轮不裁（数据安全优先，宁可账胖着）；
//   - 归档文件保留 WFP_LEDGER_ARCHIVE_KEEP 份（默认 12，0=关闭归档=回到旧行为），
//     超限删最旧（归档本身也要有界，不把"只增不删"的病搬到 archive/）；
//   - ledger-state.json 记 lastArchive/archivedTotal（可观测面）。
export function ledgerArchiveKeep() {
  const n = Number(process.env.WFP_LEDGER_ARCHIVE_KEEP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12;
}

const archiveDir = (repoRoot) => path.join(repoRoot, "stats", "archive");

/** 被裁行落归档：返回 { path, rows }；keep=0 如实返回 { skipped: true } */
function archiveTrimmed(repoRoot, file, trimmedRows) {
  const keep = ledgerArchiveKeep();
  if (keep === 0 || trimmedRows.length === 0) return { skipped: true, keep, rows: trimmedRows.length };
  fs.mkdirSync(archiveDir(repoRoot), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(archiveDir(repoRoot), `${file.replace(/\.jsonl$/, "")}-${stamp}.jsonl`);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, trimmedRows.map((r) => JSON.stringify(r)).join("\n") + "\n"); // 原子落盘：半份归档不出现
  fs.renameSync(tmp, p);
  // 归档有界：超 keep 份删最旧（文件名时间戳字典序=时间序）
  const all = fs.readdirSync(archiveDir(repoRoot))
    .filter((f) => f.startsWith(`${file.replace(/\.jsonl$/, "")}-`) && f.endsWith(".jsonl"))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(archiveDir(repoRoot), old), { force: true });
  return { path: p, rows: trimmedRows.length, keep };
}

const ledgerStatePath = (repoRoot) => path.join(repoRoot, "stats", "ledger-state.json");

// ---- 归档消费面（十四轮）：归档文件本身有人看 ----
// 痛点（十三轮留题）：trim 被裁行落了 stats/archive/，但消费面为零——审计时
// 只能人肉 grep archive/*.jsonl。market archive 一条命令读归档：
//   - 清单面：每份归档（账名/行数/坏行/字节/落档时间/首末行时间）新→旧；
//   - --ledger <events|feedback|queries> 只看一本账（未知名报错不猜）；
//   - --grep <text> 跨归档行检索（大小写不敏感子串，原文 JSON 行带出处），
//     命中封顶 --limit（默认 50）防一屏刷爆，超了如实 truncated；
//   - --regex（十六轮）：--grep 的模式按正则解释（大小写不敏感；坏正则报错
//     不静默当子串）；--and（十六轮）：--grep 的模式按多词 AND 解释（空白分词、
//     每词都是子串、与顺序无关——审计常要"这几个词都在"而不是"这个整句在"）；
//     两修饰同用报错，都不给 --grep 报错——修饰不悬空；
//   - --live（十五轮）：grep 口径跨账+档一体化——在账明细行（stats/<账>.jsonl，
//     审计意义上的"最新段"）一并纳入检索，命中带 source=live|archive 出处，
//     live 在前（在账=未被裁的最新行，归档=更早被裁的历史行，时间序自然衔接）；
//   - 坏行不连坐：单行解析失败计 badRows，别的行照常可审计。
export function archiveIndex(repoRoot, { ledger, grep, limit = 50, includeLive = false, mode = "substr" } = {}) {
  const ledgerNames = LEDGERS.map((l) => l.replace(/\.jsonl$/, "")); // 归档前缀不带扩展名
  if (ledger && !ledgerNames.includes(ledger)) {
    throw new Error(`unknown ledger: ${ledger}（可选：${ledgerNames.join(" | ")}）`);
  }
  // 检索模式（十六轮）：substr=大小写不敏感子串（老口径分毫不动）；
  // regex=正则解释（坏正则报错不静默降级）；and=空白分词全子串（顺序无关）
  if (mode !== "substr" && mode !== "regex" && mode !== "and") {
    throw new Error(`unknown grep mode: ${mode}（可选：substr | regex | and）`);
  }
  let matcher = null;
  if (grep != null) {
    const pattern = String(grep);
    if (mode === "regex") {
      let re;
      try {
        re = new RegExp(pattern, "i");
      } catch (err) {
        throw new Error(`invalid regex "${pattern}"：${err.message}——修模式或去掉 --regex 按子串检索`);
      }
      matcher = (line) => re.test(line);
    } else if (mode === "and") {
      const tokens = pattern.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
      if (tokens.length === 0) throw new Error(`--and 模式无有效词："${pattern}"（空白分词后为空）`);
      matcher = (line) => {
        const l = line.toLowerCase();
        return tokens.every((t) => l.includes(t));
      };
    } else {
      const needle = pattern.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(needle);
    }
  }
  const files = [];
  const liveFiles = [];
  const matches = [];
  let truncated = false;
  const pushMatch = (source, file, line) => {
    if (matches.length >= limit) truncated = true;
    else matches.push({ source, file, line }); // 原文 JSON 行带出处（在账 or 哪份归档）
  };
  // 在账明细（live）：最新段先行——账没裁过时它就是全部明细，裁过则是归档的"续篇"
  if (includeLive) {
    for (const file of LEDGERS) {
      if (ledger && file !== `${ledger}.jsonl`) continue;
      const p = path.join(repoRoot, "stats", file);
      let raw;
      try {
        raw = fs.readFileSync(p, "utf8");
      } catch {
        continue; // 未开张的账如实跳过（不冒充空文件）
      }
      const lines = raw.split("\n").filter(Boolean);
      let badRows = 0;
      const ats = [];
      for (const line of lines) {
        if (matcher && matcher(line)) pushMatch("live", file, line);
        try {
          const row = JSON.parse(line);
          if (row && typeof row.at === "string") ats.push(row.at);
        } catch {
          badRows += 1;
        }
      }
      ats.sort();
      liveFiles.push({
        file,
        ledger: file.replace(/\.jsonl$/, ""),
        rows: lines.length,
        badRows,
        bytes: Buffer.byteLength(raw),
        firstAt: ats[0] ?? null,
        lastAt: ats[ats.length - 1] ?? null,
      });
    }
  }
  const dir = archiveDir(repoRoot);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse(); // 文件名时间戳倒序 = 新→旧
  } catch {
    // archive/ 不存在：归档面如实为空（在账 live 面照常可审计，不再整体短路）
  }
  if (ledger) names = names.filter((f) => f.startsWith(`${ledger}-`));
  for (const name of names) {
    const p = path.join(dir, name);
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    let badRows = 0;
    const ats = [];
    for (const line of lines) {
      if (matcher && matcher(line)) pushMatch("archive", name, line);
      try {
        const row = JSON.parse(line);
        if (row && typeof row.at === "string") ats.push(row.at);
      } catch {
        badRows += 1; // 坏行如实计数不连坐
      }
    }
    ats.sort();
    files.push({
      file: name,
      ledger: ledgerNames.find((l) => name.startsWith(`${l}-`)) ?? null, // 前缀对不上账名的如实 null
      rows: lines.length,
      badRows,
      bytes: Buffer.byteLength(raw),
      archivedAt: fs.statSync(p).mtime.toISOString(),
      firstAt: ats[0] ?? null,
      lastAt: ats[ats.length - 1] ?? null,
    });
  }
  const result = { files };
  if (includeLive) result.liveFiles = liveFiles;
  if (matcher != null) {
    result.grep = String(grep);
    if (mode !== "substr") result.mode = mode; // substr 是默认口径不标（老消费方零 churn）
    result.matches = matches;
    result.truncated = truncated;
    const liveHits = matches.filter((m) => m.source === "live").length;
    if (matches.length === 0 && !truncated) {
      result.note = includeLive
        ? `no rows match "${grep}"（在账+归档）`
        : `no archived rows match "${grep}"`; // 归档口径原话保留（back-compat）
    } else if (includeLive) result.hitsBySource = { live: liveHits, archive: matches.length - liveHits };
  }
  if (files.length === 0 && matcher == null) result.note = `no archives${ledger ? ` for ledger ${ledger}` : ""} yet`;
  return result;
}

// ---- 台账写侧并发保护（十三轮）：jsonl"单进程写"假设钉死 ----
// 痛点：appendLedger/trimLedger/ingestEvents 全是读-改-写裸奔——两进程同时 trim
// 同一本账理论可交错（半行/重行/丢行），ledger-state.json 也会后写者整体覆盖前写者。
// 口径（与 ks withStateLock 同款）：stats/.ledger.lock 独占锁（wx 原子创建）+
// 有限重试（WFP_LEDGER_LOCK_TIMEOUT_MS 默认 2000ms）+陈锁超龄接管（30s，崩溃残留不卡死）。
const LEDGER_LOCK_STALE_MS = 30 * 1000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** 台账独占锁：callback 全程持锁（append/trim/折叠的读-改-写整段原子） */
export function withLedgerLock(repoRoot, callback) {
  const lockPath = path.join(repoRoot, "stats", ".ledger.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const timeoutMs = Number(process.env.WFP_LEDGER_LOCK_TIMEOUT_MS || 2000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAgeMs > LEDGER_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue; // 陈锁接管：持锁进程崩溃残留不卡死后续写
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue; // 持锁者刚释放，立即重试
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`ledger is busy (lock held); retry after the active market operation finishes`);
      sleepSync(50);
      continue;
    }
    try {
      return callback();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function readLedgerState(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(ledgerStatePath(repoRoot), "utf8"));
  } catch {
    return {};
  }
}

function noteTrimmed(repoRoot, file, trimmed, kept, archive = null) {
  const state = readLedgerState(repoRoot);
  const prev = state[file] ?? { trimmedTotal: 0, archivedTotal: 0 };
  state[file] = {
    trimmedTotal: prev.trimmedTotal + trimmed,
    archivedTotal: prev.archivedTotal + (archive?.rows ?? 0),
    lastTrimmedAt: new Date().toISOString(),
    keptAtLastTrim: kept,
    ...(archive?.path ? { lastArchive: { path: archive.path, rows: archive.rows, at: new Date().toISOString() } } : {}),
  };
  fs.mkdirSync(path.dirname(ledgerStatePath(repoRoot)), { recursive: true });
  fs.writeFileSync(ledgerStatePath(repoRoot), JSON.stringify(state, null, 2) + "\n");
}

/** 收敛一本账：保尾部 max 条 + 谓词保护条目（相对顺序不变），原子落盘。
 *  公开形态持台账锁（十三轮并发保护）；锁内复用 Unlocked 形态防自死锁。 */
export function trimLedger(repoRoot, file, max = ledgerMax(), protect = null) {
  return withLedgerLock(repoRoot, () => trimLedgerUnlocked(repoRoot, file, max, protect));
}

function trimLedgerUnlocked(repoRoot, file, max, protect) {
  const p = path.join(repoRoot, "stats", file);
  if (max <= 0) return { file, before: 0, after: 0, trimmed: 0, note: "自治关闭（WFP_LEDGER_MAX=0）" };
  let rows;
  try {
    rows = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { file, before: 0, after: 0, trimmed: 0, note: "台账未开张" };
  }
  if (rows.length <= max) return { file, before: rows.length, after: rows.length, trimmed: 0 };
  const keepIdx = new Set();
  if (protect) rows.forEach((r, i) => { if (protect(r)) keepIdx.add(i); });
  for (let i = rows.length - 1; i >= 0 && keepIdx.size < max; i -= 1) keepIdx.add(i);
  const kept = rows.filter((_, i) => keepIdx.has(i));
  const trimmedRows = rows.filter((_, i) => !keepIdx.has(i));
  // 归档先行（十三轮）：被裁行落 archive/ 后才动真账——归档失败本轮不裁，数据安全优先
  let archive;
  try {
    archive = archiveTrimmed(repoRoot, file, trimmedRows);
  } catch (error) {
    return { file, before: rows.length, after: rows.length, trimmed: 0, note: `归档失败本轮不裁：${error.message}` };
  }
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.renameSync(tmp, p);
  noteTrimmed(repoRoot, file, rows.length - kept.length, kept.length, archive.skipped ? null : archive);
  return {
    file, before: rows.length, after: kept.length, trimmed: rows.length - kept.length,
    ...(archive.skipped ? {} : { archived: archive.rows, archivePath: archive.path }),
  };
}

/** 有界追加：正常走 append；超封顶走收敛（保护条目永不裁）。持锁（十三轮） */
export function appendLedger(repoRoot, file, row, protect = null) {
  return withLedgerLock(repoRoot, () => {
    const p = path.join(repoRoot, "stats", file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const max = ledgerMax();
    let lines = 0;
    try {
      lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
    } catch { /* 未开张 */ }
    fs.appendFileSync(p, JSON.stringify(row) + "\n");
    if (max > 0 && lines + 1 > max) {
      const r = trimLedgerUnlocked(repoRoot, file, max, protect);
      return { trimmed: r.trimmed };
    }
    return { trimmed: 0 };
  });
}

/** 台账健康面：每本账行数/字节/封顶/累计裁剪（report 如实展示） */
export function ledgerHealth(repoRoot) {
  const state = readLedgerState(repoRoot);
  return LEDGERS.map((file) => {
    const p = path.join(repoRoot, "stats", file);
    let lines = 0, bytes = 0;
    try {
      const raw = fs.readFileSync(p, "utf8");
      lines = raw.split("\n").filter(Boolean).length;
      bytes = Buffer.byteLength(raw);
    } catch { /* 未开张如实 0 */ }
    return {
      file,
      lines,
      bytes,
      max: ledgerMax(),
      trimmedTotal: state[file]?.trimmedTotal ?? 0,
      lastTrimmedAt: state[file]?.lastTrimmedAt ?? null,
      archivedTotal: state[file]?.archivedTotal ?? 0,
      lastArchive: state[file]?.lastArchive ?? null,
    };
  });
}

export function logQuery(repoRoot, query) {
  const q = String(query || "").trim();
  if (!q) return;
  appendLedger(repoRoot, "queries.jsonl", { q, at: new Date().toISOString() });
}

// ---- 数据面体检（二十二轮）：market doctor 一条命令回真话 ----
// 痛点：账面的完整性只有两处守门——测试门（市场条目下载 key 覆盖门）与写入口校验
// （record/feedback 拒未知名），账本身被手改/丢账/死引用没有任何 runtime 面点名：
// report 遇死键静默 continue，坏行靠 topQueries 的 catch 吞掉，坏了没人知道。
// doctor 全程只读，逐项检查宁红勿默（任何红 → ok:false，CLI exit 1）：
//   ① marketplace.manifest：清单可读 + name 唯一 + integrity 形态（sha256:<64hex>）；
//   ② downloads.key-coverage：死键（插件名已不在市场）与缺键（非 bundled 条目无 key）
//      双向点名；旧版本 key（名在场、版本已退役）是历史账如实列出不冒红；
//   ③ ledger.rows-parsable：三本账逐行 JSON 可解析，坏行（文件:行号）点名不连坐；
//   ④ events.sequence：seq 沿文件严格递增（重复/倒退=锁失效或手改）+ foldedSeq 水位
//      ≤ 最大 seq（超水位=折叠了不存在的事件）+ 未归账 install（seq>水位）点名指路
//      market ingest（record 当场归账，稳态应为 0）；
//   ⑤ downloads.counts-vs-events：每个 key 的已折叠 install 数 ≤ counts——bump 只会加，
//      低于即丢账/手改（裁剪只裁已归账旧事件，不变量存活）。
export function doctorMarket(repoRoot = root) {
  const checks = [];
  const push = (id, findings, note, extra = {}) =>
    checks.push({ id, ok: findings.length === 0, findings, note, ...extra });

  // ① 市场清单结构（后续检查的前提；读不了整单红，不装死）
  const manifestFindings = [];
  let index = null;
  try {
    index = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    const names = index.plugins.map((p) => p.name);
    for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
      manifestFindings.push({ kind: "duplicate-name", name });
    }
    for (const p of index.plugins) {
      if (p.integrity != null && !/^sha256:[0-9a-f]{64}$/.test(p.integrity)) {
        manifestFindings.push({ kind: "malformed-integrity", name: p.name, integrity: p.integrity });
      }
    }
  } catch (error) {
    manifestFindings.push({ kind: "unreadable", reason: error.message });
  }
  push("marketplace.manifest", manifestFindings, "清单可读 / name 唯一 / integrity 形态 sha256:<64hex>");

  const knownKeys = new Set(index ? index.plugins.map((p) => `${p.name}@${p.version}`) : []);
  const knownNames = new Set(index ? index.plugins.map((p) => p.name) : []);
  const nonBundled = index ? index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]) : [];

  // ② 下载台账键覆盖（双向）——counts 缺文件时红，此后账实检查按 0 计
  const dlFindings = [];
  const historicalKeys = [];
  let counts = {};
  let foldedSeq = 0;
  try {
    const stats = JSON.parse(fs.readFileSync(path.join(repoRoot, "stats", "downloads.json"), "utf8"));
    counts = stats.counts || {};
    foldedSeq = stats.foldedSeq ?? 0;
  } catch {
    dlFindings.push({ kind: "unreadable", file: "stats/downloads.json" });
  }
  for (const key of Object.keys(counts)) {
    const name = key.split("@")[0];
    if (!knownNames.has(name)) dlFindings.push({ kind: "dead-key", key, reason: "插件名已不在市场" });
    else if (!knownKeys.has(key)) historicalKeys.push(key); // 旧版本历史账：在场如实列出不冒红
  }
  for (const p of nonBundled) {
    const key = `${p.name}@${p.version}`;
    if (!(key in counts)) dlFindings.push({ kind: "missing-key", key, reason: "非 bundled 条目台账无 key（覆盖门同口径）" });
  }
  push("downloads.key-coverage", dlFindings, "死键（名已下架）/缺键（非 bundled 条目无 key）双向对账", { historicalKeys });

  // ③ 三本账逐行可解析 + 收集事件（文件未开张如实跳过）
  const events = [];
  const rowFindings = [];
  for (const file of LEDGERS) {
    let raw;
    try { raw = fs.readFileSync(path.join(repoRoot, "stats", file), "utf8"); } catch { continue; }
    raw.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const row = JSON.parse(line);
        if (file === "events.jsonl") events.push(row);
      } catch (error) {
        rowFindings.push({ kind: "bad-row", file, line: i + 1, reason: error.message });
      }
    });
  }
  push("ledger.rows-parsable", rowFindings, "三本账逐行 JSON 可解析（坏行点名不连坐）");

  // ④ 事件序列与水位
  const seqFindings = [];
  let prevSeq = 0;
  let maxSeq = 0;
  for (const e of events) {
    const seq = Number(e.seq) || 0;
    if (seq <= prevSeq) {
      seqFindings.push({ kind: seq === prevSeq ? "duplicate-seq" : "non-monotonic-seq", seq, prev: prevSeq, at: e.at ?? null });
    }
    prevSeq = seq;
    maxSeq = Math.max(maxSeq, seq);
  }
  if (events.length > 0 && foldedSeq > maxSeq) {
    seqFindings.push({ kind: "watermark-beyond-events", foldedSeq, maxSeq, reason: "折叠水位超过账内最大 seq——事件账与下载台账脱节" });
  }
  const pending = events.filter((e) => e.type === "install" && (Number(e.seq) || 0) > foldedSeq);
  for (const e of pending) {
    seqFindings.push({ kind: "pending-install", seq: e.seq, plugin: `${e.plugin}@${e.version}`, hint: "node scripts/market.mjs ingest" });
  }
  push("events.sequence", seqFindings, "seq 严格递增 / 水位 ≤ 最大 seq / 未归账 install 稳态为 0");

  // ⑤ 账实相符：已折叠 install 数 ≤ counts（bump 只会加，低于即丢账）
  const foldedCounts = new Map();
  for (const e of events) {
    if (e.type !== "install" || (Number(e.seq) || 0) > foldedSeq) continue;
    const key = `${e.plugin}@${e.version}`;
    foldedCounts.set(key, (foldedCounts.get(key) ?? 0) + 1);
  }
  const driftFindings = [];
  for (const [key, n] of foldedCounts) {
    if ((counts[key] ?? 0) < n) {
      driftFindings.push({ kind: "counts-below-folded", key, counts: counts[key] ?? 0, folded: n });
    }
  }
  push("downloads.counts-vs-events", driftFindings, "每个 key 已折叠 install 数 ≤ 台账计数（低于=丢账/手改）");

  const red = checks.filter((c) => !c.ok).length;
  return { ok: red === 0, checks, summary: { checks: checks.length, red, green: checks.length - red } };
}

function topQueries(repoRoot, limit = 5) {
  let lines = [];
  try { lines = fs.readFileSync(queriesPath(repoRoot), "utf8").split("\n").filter(Boolean); } catch { return []; }
  const counts = new Map();
  for (const l of lines) {
    try { const { q } = JSON.parse(l); counts.set(q, (counts.get(q) ?? 0) + 1); } catch { /* 坏行跳过 */ }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

// ---- 时间维度（十一轮）：三本账只有总量不知道方向——按 ISO 周分桶+环比 ----
// 事件/反馈/查询三本账都有 at 时间戳：weeklyTrend 把它们折成每周计数，
// 环比（wow）= 最近完整周 vs 前一周（进行中当周如实标 partial，不冒充完整周）。

/** ISO 周键：'YYYY-Www'（周一为一周之始，与报表口径一致） */
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // 周日=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // 本周四=ISO 年锚点
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function readJsonl(repoRoot, file) {
  try {
    return fs.readFileSync(path.join(repoRoot, "stats", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** 三本账按周分桶：最近 weeks 周（含当周），周键升序；无记录的周计 0（趋势不断档） */
export function weeklyTrend(repoRoot, weeks = 4) {
  const installs = readJsonl(repoRoot, "events.jsonl").filter((e) => e.type === "install");
  const feedback = readJsonl(repoRoot, "feedback.jsonl");
  const searches = readJsonl(repoRoot, "queries.jsonl");
  const bucket = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!r.at) continue;
      const k = isoWeekKey(new Date(r.at));
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const bi = bucket(installs), bf = bucket(feedback), bs = bucket(searches);
  // 周序列：从当周回溯 weeks-1 周，保证连续
  const now = new Date();
  const keys = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 7 * 86400000);
    keys.push(isoWeekKey(d));
  }
  const series = keys.map((k) => ({ week: k, installs: bi.get(k) ?? 0, feedback: bf.get(k) ?? 0, searches: bs.get(k) ?? 0 }));
  // 环比：最近完整周（倒数第二）vs 前一周（倒数第三）；周数不足或前周为 0 如实 null（不编 ∞%）
  const last = series[series.length - 2], prev = series[series.length - 3];
  const wowOf = (a, b) => (last && prev && b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
  const partial = series.length > 0 ? series[series.length - 1].week === isoWeekKey(now) : false;
  return {
    series,
    partial,
    wow: last && prev
      ? { week: last.week, installs: wowOf(last.installs, prev.installs), feedback: wowOf(last.feedback, prev.feedback), searches: wowOf(last.searches, prev.searches), note: "最近完整周 vs 前一周（%）；null=前周为零或周数不足，如实不编" }
      : null,
  };
}

/** 聚合报表：下载总量/份额榜/版本摊薄/搜索热度（零下载如实点名，不灌水） */
export function buildReport(catalog, repoRoot = root, { topN = 5 } = {}) {
  const byName = new Map(catalog.entries.map((e) => [e.name, e]));
  const versionSpread = new Map(); // name -> {version: count}
  for (const [key, n] of Object.entries(catalog.downloadsRaw)) {
    const [name, ver] = key.split("@");
    if (!byName.has(name)) continue; // 死 key 由台账覆盖门看守，报表不重复执法
    const spread = versionSpread.get(name) ?? new Map();
    spread.set(ver, n);
    versionSpread.set(name, spread);
  }
  const total = catalog.entries.reduce((s, e) => s + e.downloads, 0);
  const leaderboard = [...catalog.entries]
    .sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name))
    .map((e, i) => {
      const spread = versionSpread.get(e.name) ?? new Map([[e.version, e.downloads]]);
      return {
        rank: i + 1,
        plugin: `${e.name}@${e.version}`,
        downloads: e.downloads,
        share: total === 0 ? 0 : Math.round((e.downloads / total) * 1000) / 10,
        versions: [...spread.entries()].map(([v, n]) => `${v}:${n}`),
        bundled: Boolean(e["bundled-in-kaleidosphere"]),
      };
    });
  const heat = topQueries(repoRoot, topN).map(([q, n]) => ({ query: q, searches: n, topHit: searchPlugins(catalog, q)[0]?.name ?? null }));
  const trend = weeklyTrend(repoRoot, 4);
  const ledgers = ledgerHealth(repoRoot); // 台账健康面（十二轮）：行数/封顶/累计裁剪如实可见
  return { total, zeroDownload: leaderboard.filter((r) => r.downloads === 0).map((r) => r.plugin), leaderboard, heat, trend, ledgers };
}

// ---- 导出面（十七轮）：报表只在终端滚，落盘给表格工具/下游脚本消费 ----
// 口径（宁红勿默，与仓内先例同款）：
//   - 格式按扩展名判定：.json = 完整报表对象（与 --json stdout 同源同值）；
//     .csv = 榜单表（rank,plugin,downloads,share,versions,bundled）——热度/趋势/
//     台账健康非表格形态走 JSON，CSV 不硬凑多表；
//   - 未知扩展名报错退出，不猜默认（用户笔误静默落错格式比报错更贵）；
//   - tmp+rename 原子落盘（与三本账写侧同款约定），父目录不存在自动建。

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(" ") : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; // RFC4180：引号 doubling，含逗号/换行/引号才加壳
};

/** 报表落盘：返回 { path, format, rows }；未知扩展名抛错（CLI 转红） */
export function exportReport(report, outPath) {
  const ext = path.extname(outPath).toLowerCase();
  if (ext !== ".csv" && ext !== ".json") {
    throw new Error(`不认识的导出扩展名 "${ext || "(无)"}"——只支持 .csv（榜单表）/ .json（完整报表），宁报错不猜默认`);
  }
  const body = ext === ".csv"
    ? [["rank", "plugin", "downloads", "share", "versions", "bundled"].join(",")]
        .concat(report.leaderboard.map((r) => [r.rank, r.plugin, r.downloads, r.share, r.versions.join(" "), r.bundled ? "true" : "false"].map(csvCell).join(",")))
        .join("\n") + "\n"
    : JSON.stringify(report, null, 2) + "\n";
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, outPath); // 原子落盘：读到的是整份报表或没有，没有半份
  return { path: outPath, format: ext.slice(1), rows: ext === ".csv" ? report.leaderboard.length : 1 };
}

// ---- CLI ----
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") flags.live = true; // 布尔开关：grep 口径跨账+档一体化（十五轮）
    else if (a === "--regex") flags.regex = true; // 布尔开关：--grep 按正则解释（十六轮）
    else if (a === "--and") flags.and = true; // 布尔开关：--grep 按多词 AND 解释（十六轮）
    else if (a === "--json" || a === "--category" || a === "--sort" || a === "--by" || a === "--consumer" || a === "--kind" || a === "--max" || a === "--ledger" || a === "--grep" || a === "--limit" || a === "--export") {
      if (a === "--json") flags.json = true;
      else flags[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const render = (p) => `${p.name}@${p.version}  [${p.category}]  ↓${p.downloads}  ${p.description?.slice(0, 60) || ""}`;
const renderScored = (p) => `${render(p)}  score=${p.score}(${p.fields.join("+")})`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  const catalog = loadCatalog();
  if (cmd === "list") {
    const items = listPlugins(catalog, { category: flags.category, sort: flags.sort });
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else if (items.length) items.forEach((p) => console.log(render(p)));
    else console.log("(空)");
  } else if (cmd === "search") {
    logQuery(root, pos.join(" ")); // 搜索热度采集（九轮报表数据面；WFP_ROOT 下写临时根）
    const items = searchPlugins(catalog, pos.join(" "));
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else if (items.length) items.forEach((p) => console.log(renderScored(p)));
    else console.log(`未命中：${pos.join(" ")}`);
  } else if (cmd === "info") {
    const p = catalog.entries.find((e) => e.name === pos[0]);
    if (!p) { console.error(`未找到插件：${pos[0]}`); process.exit(1); }
    console.log(flags.json ? JSON.stringify(p, null, 2) : render(p));
  } else if (cmd === "stats") {
    if (flags.json) console.log(JSON.stringify(catalog.downloadsRaw, null, 2));
    else Object.entries(catalog.downloadsRaw).forEach(([k, v]) => console.log(`${k}  ↓${v}`));
  } else if (cmd === "bump") {
    const n = bumpDownloads(root, pos[0], Number(flags.by) || 1);
    if (n == null) { console.error(`未找到插件：${pos[0]}`); process.exit(1); }
    console.log(`${pos[0]} 下载量 → ${n}`);
  } else if (cmd === "record") {
    try {
      const r = recordInstall(root, pos[0], { consumer: flags.consumer || "unknown" });
      if (!r) { console.error(`未找到插件：${pos[0]}`); process.exit(1); }
      console.log(`事件 seq=${r.event.seq} 已落通道并归账（本次折叠 ${r.folded} 条）`);
    } catch (err) {
      console.error(err.message); process.exit(1);
    }
  } else if (cmd === "ingest") {
    const n = ingestEvents(root);
    console.log(`归账 ${n} 条安装事件（幂等：重跑为 0）`);
  } else if (cmd === "feedback") {
    const [, ...textParts] = pos;
    const fb = submitFeedback(root, pos[0], textParts.join(" "), { kind: flags.kind || "review" });
    if (!fb) { console.error(`未找到插件：${pos[0]}`); process.exit(1); }
    console.log(`已留档（已脱敏）：${fb.record.text}`);
    console.log(`提交 issue：${fb.url}`);
  } else if (cmd === "report") {
    const report = buildReport(catalog, root);
    if (flags.export != null) {
      // 导出面（十七轮）：落盘优先于 stdout 渲染——CSV 只导榜单表，JSON 与 --json 同源同值
      let out;
      try {
        out = exportReport(report, flags.export);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      console.log(`已导出 ${out.path}（${out.format}，${out.format === "csv" ? `${out.rows} 行榜单` : "完整报表口径"}）`);
    }
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`下载总量 ${report.total}（零下载：${report.zeroDownload.join("、") || "无"}）`);
      report.leaderboard.forEach((r) => console.log(`#${r.rank} ${r.plugin}  ↓${r.downloads}  share=${r.share}%${r.bundled ? "  [bundled]" : ""}`));
      if (report.heat.length) {
        console.log("搜索热度：");
        report.heat.forEach((h) => console.log(`  ${h.searches}×  "${h.query}" → ${h.topHit ?? "无命中"}`));
      } else console.log("搜索热度：暂无查询记录（数据面如实起步）");
      if (report.trend) {
        const t = report.trend;
        console.log(`周趋势（${t.series.length} 周${t.partial ? "，当周进行中" : ""}）：`);
        t.series.forEach((w) => console.log(`  ${w.week}  ↓${w.installs}  反馈 ${w.feedback}  搜索 ${w.searches}`));
        if (t.wow) {
          const f = (v) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v}%`);
          console.log(`环比（${t.wow.week} vs 前一周）：下载 ${f(t.wow.installs)}  反馈 ${f(t.wow.feedback)}  搜索 ${f(t.wow.searches)}`);
        } else console.log("环比：周数不足（数据起步第一周，下周起出环比）");
      }
      console.log("台账健康：");
      report.ledgers.forEach((l) => console.log(`  ${l.file}  ${l.lines} 行 / ${l.bytes} B  封顶 ${l.max}  累计裁 ${l.trimmedTotal}  累计归档 ${l.archivedTotal}${l.lastArchive ? `（最近 ${path.basename(l.lastArchive.path)} ${l.lastArchive.rows} 行）` : ""}`));
    }
  } else if (cmd === "ledger") {
    // 台账快查（十七轮）：ledgerHealth 单独入口——report 的内嵌面要点名看时不必翻整份报表
    const ledgers = ledgerHealth(root);
    if (flags.json) console.log(JSON.stringify(ledgers, null, 2));
    else ledgers.forEach((l) => console.log(
      `${l.file}  ${l.lines} 行 / ${l.bytes} B  封顶 ${l.max}  累计裁 ${l.trimmedTotal}${l.lastTrimmedAt ? `（最近 ${l.lastTrimmedAt}）` : ""}  累计归档 ${l.archivedTotal}${l.lastArchive ? `（最近 ${path.basename(l.lastArchive.path)} ${l.lastArchive.rows} 行）` : ""}`,
    ));
  } else if (cmd === "trim") {
    const max = flags.max ? Number(flags.max) : ledgerMax();
    for (const file of LEDGERS) {
      const watermark = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, "stats", "downloads.json"), "utf8")).foldedSeq ?? 0; } catch { return 0; } })();
      const protect = file === "events.jsonl" ? (e) => (e.seq || 0) > watermark : null;
      const r = trimLedger(root, file, max, protect);
      const archived = r.archived != null ? `，归档 ${r.archived} 行 → ${path.basename(r.archivePath)}` : "";
      console.log(`${r.file}  ${r.before} → ${r.after}（裁 ${r.trimmed}${archived}${r.note ? `，${r.note}` : ""}）`);
    }
  } else if (cmd === "archive") {
    // 归档消费面（十四轮）：审计不再人肉 grep archive/*.jsonl。
    // --live（十五轮）：grep 口径跨账+档一体化——在账明细一并纳入。
    // --regex/--and（十六轮）：--grep 的检索模式修饰——同用/悬空都报错不猜。
    if (flags.regex && flags.and) { console.error("--regex 与 --and 互斥（一次一个检索口径）"); process.exit(1); }
    if ((flags.regex || flags.and) && flags.grep == null) { console.error("--regex/--and 是 --grep 的修饰，需与 --grep <pattern> 同用"); process.exit(1); }
    const mode = flags.regex ? "regex" : flags.and ? "and" : "substr";
    let archive;
    try {
      archive = archiveIndex(root, { ledger: flags.ledger, grep: flags.grep, limit: flags.limit ? Number(flags.limit) : 50, includeLive: Boolean(flags.live), mode });
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    if (flags.json) console.log(JSON.stringify(archive, null, 2));
    else if (archive.grep != null) {
      archive.matches.forEach((m) => console.log(`[${m.source === "live" ? "live:" : "arch:"}${m.file}] ${m.line}`));
      const parts = [];
      if (archive.hitsBySource) parts.push(`live ${archive.hitsBySource.live} · 归档 ${archive.hitsBySource.archive}`);
      console.log(archive.matches.length
        ? `命中 ${archive.matches.length} 行${parts.length ? `（${parts[0]}）` : ""}${archive.truncated ? "（超 --limit 封顶，已截断）" : ""}`
        : (archive.note || "未命中"));
    } else {
      if (archive.liveFiles) archive.liveFiles.forEach((f) => console.log(`[live] ${f.file}  ${f.rows} 行（坏 ${f.badRows}）/ ${f.bytes} B${f.lastAt ? `  首末 ${f.firstAt} → ${f.lastAt}` : ""}`));
      if (!archive.files.length) console.log(archive.note || "(空)");
      else archive.files.forEach((f) => console.log(`${f.file}  ${f.rows} 行（坏 ${f.badRows}）/ ${f.bytes} B  落档 ${f.archivedAt}${f.lastAt ? `  首末 ${f.firstAt} → ${f.lastAt}` : ""}`));
    }
  } else if (cmd === "doctor") {
    // 数据面体检（二十二轮）：全程只读——红则 exit 1 逐条点名，绿则如实全绿
    const result = doctorMarket(root);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const c of result.checks) {
        console.log(`${c.ok ? "✓" : "✗"} ${c.id}  ${c.note ?? ""}`);
        if (c.historicalKeys?.length) console.log(`    历史版本 key（在场如实列出，不冒红）：${c.historicalKeys.join("、")}`);
        for (const f of c.findings) console.log(`    ${JSON.stringify(f)}`);
      }
      console.log(result.ok
        ? `体检通过：${result.summary.green}/${result.summary.checks} 项全绿`
        : `体检不过：${result.summary.red}/${result.summary.checks} 项红——逐条见上，宁红勿默`);
    }
    if (!result.ok) process.exit(1);
  } else {
    console.log("用法：market list [--category c] [--sort name|downloads] | search <q> | info <name> | stats | bump <name> [--by N] | record <name> [--consumer c] | ingest | feedback <name> <text> [--kind bug|idea|review] | report [--json] [--export <file.csv|file.json>] | ledger [--json] | doctor [--json] | trim [--max N] | archive [--ledger events|feedback|queries] [--grep <text>] [--regex] [--and] [--live] [--limit N] [--json]");
    process.exit(cmd ? 1 : 0);
  }
}
