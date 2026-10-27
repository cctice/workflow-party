// 沙箱安装运行验证：上架门从"产物校验"升级为"装上真跑一遍"。
//
// 此前 artifact-integrity 验证的是仓库里的 tgz 内容；但"tgz 内容对"不等于
// "装到别处能跑"——安装器视角的问题（解包布局、skills 清单可发现、入口
// 文件可读）只有真装一次才知道。
//
// 本测试对每个本地产物执行完整安装路径：
//   解包 tgz → 临时沙箱 → 按插件装载器视角校验布局与技能可发现性 →
//   冒烟执行装载动作（读取全部 SKILL.md frontmatter 并验证结构）。
// 沙箱用后即焚，不污染仓库。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
const localListings = index.plugins.filter((p) => !p["bundled-in-kaleidosphere"]);

function readTarEntries(gzBuffer) {
  const buf = zlib.gunzipSync(gzBuffer);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const typeFlag = String.fromCharCode(header[156]);
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeFlag === "0" || typeFlag === "\0") {
      const name = prefix ? `${prefix}/${rawName}` : rawName;
      entries.set(name, data);
    }
  }
  return entries;
}

const stripRoot = (name) => name.replace(/^[^/]+\//, "");

/** 模拟安装器：把 tgz 解到 sandbox 目录，返回安装根 */
function installToSandbox(tgzPath, sandbox) {
  const entries = readTarEntries(fs.readFileSync(tgzPath));
  const written = [];
  for (const [name, data] of entries) {
    const rel = stripRoot(name);
    if (!rel || rel.endsWith("/")) continue;
    const dest = path.join(sandbox, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written.push(rel);
  }
  return { sandbox, written };
}

/** 模拟装载器视角的冒烟：安装根内每个 SKILL.md 必须有 name/description frontmatter */
function smokeLoadSkills(sandbox) {
  const skillFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") skillFiles.push(full);
    }
  };
  walk(sandbox);
  const loaded = skillFiles.map((file) => {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter = m?.[1] ?? "";
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    return { file: path.relative(sandbox, file), name, description };
  });
  return loaded;
}

for (const entry of localListings) {
  test(`sandbox install & load: ${entry.name}@${entry.version}`, () => {
    const sourceDir = path.join(root, entry.source.replace(/^\.\//, ""));
    const tgz = fs.readdirSync(path.join(sourceDir, "resources")).find((f) => f.endsWith(".tgz"));
    assert.ok(tgz, `${entry.name}: 无产物可装`);

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `wfp-install-${entry.name}-`));
    try {
      const { sandbox: installed, written } = installToSandbox(path.join(sourceDir, "resources", tgz), sandbox);
      assert.ok(written.length > 0, `${entry.name}: 解包后无文件`);

      // 安装布局：插件清单可解析且身份正确
      const manifestPath = path.join(installed, "plugin.json");
      assert.ok(fs.existsSync(manifestPath), `${entry.name}: 安装根缺 plugin.json（装载器无从识别）`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.name, entry.name);
      assert.equal(manifest.version, entry.version);

      // 冒烟执行：技能装载（每个 SKILL.md frontmatter 结构有效）
      const skills = smokeLoadSkills(installed);
      assert.ok(skills.length > 0, `${entry.name}: 安装后无任何 SKILL.md 可发现`);
      for (const skill of skills) {
        assert.ok(skill.name, `${skill.file}: frontmatter 缺 name——技能不可索引`);
        assert.ok(skill.description && skill.description.length >= 10, `${skill.file}: description 过短——技能不可展示`);
        // 技能目录名与声明的 name 一致（发现路径 = 声明路径）
        assert.equal(
          path.basename(path.dirname(skill.file)),
          skill.name,
          `${skill.file}: 目录名与 frontmatter name 不一致——按名发现会落空`
        );
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
}
