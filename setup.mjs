// Math Tutor · 家长首次配置引导
//
// 家长在终端跑一次：  node setup.mjs
// 作用：确认环境就绪、清掉上次遗留的学习状态、验证安全网、告诉你孩子怎么开始。
// 默认模式（Mode A）不需要任何 API Key —— AI 老师就是你正在用的这个助手本身。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const STATE_PATH = path.join(HOME, ".ai-teaching-state.json");
const CONFIG_PATH = path.join(HOME, ".ai-teaching-config.json");
const LOG_PATH = path.join(HOME, ".ai-teaching-log.jsonl");

const GREEN = "\x1b[32m", RED = "\x1b[31m", YEL = "\x1b[33m", DIM = "\x1b[2m", B = "\x1b[1m", R = "\x1b[0m";
const ok = (m) => console.log(`  ${GREEN}✓${R} ${m}`);
const warn = (m) => console.log(`  ${YEL}!${R} ${m}`);
const bad = (m) => console.log(`  ${RED}✗${R} ${m}`);

let problems = 0;

console.log(`\n${B}  AI 教学引擎 · 家长配置检查${R}`);
console.log(`${DIM}  一次性检查，之后孩子直接用。${R}\n`);

// 1) Node 版本
const major = Number(process.versions.node.split(".")[0]);
if (major >= 16) ok(`Node 版本 ${process.versions.node}`);
else { bad(`Node 版本过低（${process.versions.node}），请升级到 16 以上`); problems++; }

// 2) skill 关键文件齐全
const required = ["SKILL.md", "prompts.js", "guard.mjs", "render.mjs", "turn.mjs", "log.mjs", "problem-types"];
const missing = required.filter((f) => !fs.existsSync(path.join(__dirname, f)));
if (missing.length === 0) ok("技能文件齐全");
else { bad(`缺少文件：${missing.join(", ")}`); problems++; }

// 3) 安全网自测（guard.mjs）—— 保护孩子不被泄露答案的关卡。不通过就别给孩子用。
if (fs.existsSync(path.join(__dirname, "guard.mjs"))) {
  try {
    execFileSync("node", ["guard.mjs", "--selftest"], { cwd: __dirname, stdio: "pipe" });
    ok("安全网自测通过（不泄露答案 / 一次一步 等红线已就绪）");
  } catch {
    bad("安全网自测未通过 —— 先别给孩子用，运行 node guard.mjs --selftest 看详情");
    problems++;
  }
}

// 3b) 其余脚本自测。这些坏了不会泄露答案，但会让面板画不出来或学情分析拿不到数据，
//     所以只警告不阻断——除了 turn.mjs（每轮都要走它，坏了整个流程就断了）。
const others = [
  { file: "render.mjs", label: "面板渲染器", fatal: false },
  { file: "turn.mjs", label: "每轮落盘入口", fatal: true },
  { file: "log.mjs", label: "学情日志写入器", fatal: false },
];
for (const { file, label, fatal } of others) {
  if (!fs.existsSync(path.join(__dirname, file))) continue;
  try {
    execFileSync("node", [file, "--selftest"], { cwd: __dirname, stdio: "pipe" });
    ok(`${label}自测通过`);
  } catch {
    if (fatal) { bad(`${label}自测未通过 —— 运行 node ${file} --selftest 看详情`); problems++; }
    else warn(`${label}自测未通过（node ${file} --selftest 看详情）`);
  }
}

// 4) 清理上次遗留的学习状态，保证孩子从头开始
//    注意：只清 state（单题进度），绝不动 ~/.ai-teaching-log.jsonl —— 那是跨题累积的学情数据。
if (fs.existsSync(STATE_PATH)) {
  try {
    const bak = STATE_PATH + ".bak";
    fs.copyFileSync(STATE_PATH, bak);
    fs.unlinkSync(STATE_PATH);
    ok(`已清空上次的学习状态（旧记录备份在 ${bak.replace(HOME, "~")}）`);
  } catch (e) {
    warn(`清理旧状态失败：${e.message}。可手动删除 ${STATE_PATH.replace(HOME, "~")}`);
  }
} else {
  ok("无遗留状态，孩子将从新题目开始");
}

// 4b) 学情数据积累情况（学情分析需要 ≥3 条才有意义）
const countLines = (p) => {
  if (!fs.existsSync(p)) return 0;
  try { return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length; }
  catch { return 0; }
};
// 分析按学科拆开（math-analytics / writing-analytics），所以门槛也分科算，不合并计数——
// 数学 2 条 + 作文 2 条不等于"可以分析了"，两边都还不够。
const logCount = countLines(LOG_PATH);
const writingCount = countLines(path.join(HOME, ".writing-coach-log.jsonl"));

if (logCount === 0) ok("数学学情：还没有记录（做完题会自动累积，攒够 3 条可分析）");
else if (logCount < 3) ok(`数学学情：已有 ${logCount} 条（再攒 ${3 - logCount} 条就能分析）`);
else ok(`数学学情：已有 ${logCount} 条，可以分析了 —— 对 AI 说“看看数学学情”`);

if (writingCount > 0) {
  ok(`作文学情：已有 ${writingCount} 篇（先攒着，作文分析 skill 还没建）`);
}

// 5) API 模式说明（默认无需配置）
if (fs.existsSync(CONFIG_PATH)) {
  ok(`检测到自定义 API 配置（Mode B）：${CONFIG_PATH.replace(HOME, "~")}`);
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.student) ok(`学情日志将记在“${cfg.student}”名下`);
    if (cfg.report_audience === "parent") ok("学情分析将默认按家长口述（含预警和建议）");
    else if (cfg.report_audience === "student") ok("学情分析将默认按孩子口述（不含预警）");
  } catch { warn(`${CONFIG_PATH.replace(HOME, "~")} 不是合法 JSON，将按默认模式运行`); }
} else {
  ok("使用默认模式：AI 助手本身就是老师，无需任何 API Key");
}

// 结果
console.log("");
if (problems === 0) {
  console.log(`${GREEN}${B}  配置就绪 ✓${R}\n`);
  console.log(`  ${B}孩子怎么开始：${R}`);
  console.log(`  1. 打开你平时用的 AI 助手（已装好本技能）`);
  console.log(`  2. 让孩子对它说：${B}“教我这道题：<题目>”${R}  或拍张题目照片`);
  console.log(`  3. 教学面板会自动写到 ${B}~/Downloads/ai-teaching-card.html${R}`);
  console.log(`     ${DIM}用浏览器打开这个文件，就能实时看到孩子学到哪、卡在哪、诊断结果${R}\n`);
  console.log(`  ${B}看数学学情：${R}每做完一道题会自动记一条到 ${DIM}~/.ai-teaching-log.jsonl${R}。`);
  console.log(`  攒够 3 条后对 AI 说 ${B}“看看数学学情”${R}，会在 ~/Downloads/ 生成两份报告：`);
  console.log(`    ${DIM}math-report-<日期>.html${R}          孩子也能看的版本`);
  console.log(`    ${DIM}math-report-<日期>-家长版.html${R}    含预警和补课建议`);
  console.log(`  ${DIM}文件名只是约定，不是权限——孩子照样能打开家长版。${R}`);
  console.log(`  ${DIM}作文学情是另一个 skill（还没建），两科分开分析、分开出报告。${R}\n`);
  console.log(`  ${DIM}想换成自己的 API：在 ~/.ai-teaching-config.json 里配置后重跑本脚本。${R}`);
  console.log(`  ${DIM}多个孩子共用：在同一个配置文件里加 {"student":"孩子名字"}，学情会分开统计。${R}`);
  console.log(`  ${DIM}只有你自己用（孩子不碰这台电脑）：加 {"report_audience":"parent"}，${R}`);
  console.log(`  ${DIM}学情分析就不用每次都保守地按孩子口述了。${R}\n`);
} else {
  console.log(`${RED}${B}  有 ${problems} 项需要处理${R}，按上面 ${RED}✗${R} 的提示修复后重跑 node setup.mjs\n`);
  process.exit(1);
}
