// AI Teaching Engine · 家长首次配置引导
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
const required = ["SKILL.md", "prompts.js", "guard.mjs", "problem-types"];
const missing = required.filter((f) => !fs.existsSync(path.join(__dirname, f)));
if (missing.length === 0) ok("技能文件齐全");
else { bad(`缺少文件：${missing.join(", ")}`); problems++; }

// 3) 安全网自测（guard.mjs）—— 保护孩子不被泄露答案的关卡
if (fs.existsSync(path.join(__dirname, "guard.mjs"))) {
  try {
    execFileSync("node", ["guard.mjs", "--selftest"], { cwd: __dirname, stdio: "pipe" });
    ok("安全网自测通过（不泄露答案 / 一次一步 等红线已就绪）");
  } catch {
    bad("安全网自测未通过 —— 先别给孩子用，运行 node guard.mjs --selftest 看详情");
    problems++;
  }
}

// 4) 清理上次遗留的学习状态，保证孩子从头开始
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

// 5) API 模式说明（默认无需配置）
if (fs.existsSync(CONFIG_PATH)) {
  ok(`检测到自定义 API 配置（Mode B）：${CONFIG_PATH.replace(HOME, "~")}`);
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
  console.log(`  ${DIM}想换成自己的 API：在 ~/.ai-teaching-config.json 里配置后重跑本脚本。${R}\n`);
} else {
  console.log(`${RED}${B}  有 ${problems} 项需要处理${R}，按上面 ${RED}✗${R} 的提示修复后重跑 node setup.mjs\n`);
  process.exit(1);
}
