// AI Teaching Engine · 学情日志写入器
//
// 用途：REVIEW 完成后调一次，把 ~/.ai-teaching-state.json 机械投影成一行 JSONL，
//      追加到 ~/.ai-teaching-log.jsonl。math-analytics skill 读这个文件做数学学情分析。
//
// 为什么要有这个脚本而不是"让 agent 记得写"：
//   日志是 math-analytics 的唯一输入。散文里写一句"REVIEW 后追加一条"靠的是自觉，
//   跟 guard.mjs 的设计取向不一致（那里同样不信自觉，做成了硬关卡）。
//   这里把"读哪些字段、怎么算"全部固化成代码，agent 只需在 REVIEW 末尾跑一条命令。
//
// 用法：
//   node log.mjs                    从 ~/.ai-teaching-state.json 投影并追加
//   node log.mjs --state <path>     指定 state 文件（测试用）
//   node log.mjs --dry-run          只打印将写入的那一行，不落盘
//   node log.mjs --selftest         跑内置样例
//   → stdout: {"ok":true,"written":"~/.ai-teaching-log.jsonl","records":7}
//
// 契约：本脚本只做投影，不做教学判断。state 里没有的信息，这里不发明。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DEFAULT_STATE = path.join(HOME, ".ai-teaching-state.json");
const DEFAULT_LOG = path.join(HOME, ".ai-teaching-log.jsonl");

// 引擎的五类卡点（prompts.js STUCK_TYPES）。写入时校验，不认识的值原样保留但标记出来，
// 避免分析端拿到一份跟引擎对不上的词表还不知情。
const STUCK_TYPES = ["无从下手", "审题理解错误", "方法/概念偏差", "过程跳步", "计算失误"];
const ESCAPE_REASONS = ["", "exhausted", "gave_up"];

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const bool = (v) => v === true;

// 把一道题的多轮 PRACTICE→DIAGNOSE 循环投影成数组。
// state.rounds 是首选来源；老 state 只有单个 diagnosis/intervene，退化成一条。
function projectRounds(s) {
  if (Array.isArray(s.rounds) && s.rounds.length) {
    return s.rounds.map((r, i) => ({
      n: i + 1,
      correct: bool(r.correct),
      stuck_step: int(r.stuck_step),
      stuck_type: str(r.stuck_type),
      detail: str(r.detail ?? r.reason).slice(0, 200),
      intervene_attempts: int(r.intervene_attempts ?? r.attempts),
      passed: bool(r.passed),
    }));
  }
  const d = s.diagnosis || {};
  const iv = s.intervene || {};
  const hasAny = str(d.type) || str(iv.stuck_type) || int(d.step) || int(iv.stuck_step);
  if (!hasAny && bool(d.correct)) {
    return [{ n: 1, correct: true, stuck_step: 0, stuck_type: "", detail: "", intervene_attempts: 0, passed: true }];
  }
  if (!hasAny) return [];
  return [{
    n: 1,
    correct: bool(d.correct),
    stuck_step: int(d.step ?? iv.stuck_step),
    stuck_type: str(d.type ?? iv.stuck_type),
    detail: str(d.reason ?? iv.question).slice(0, 200),
    intervene_attempts: int(iv.count),
    passed: bool(iv.passed),
  }];
}

export function project(state, now = new Date()) {
  const s = state || {};
  const p = s.problem || {};
  const sk = s.skeleton || {};
  const rounds = projectRounds(s);
  const escape_reason = ESCAPE_REASONS.includes(str(s.escape_reason)) ? str(s.escape_reason) : str(s.escape_reason);

  // 主卡点 = 最后一个未通过的轮次；全通过则取第一个卡过的轮次；从没卡过则为空。
  const failed = rounds.filter((r) => !r.correct);
  const primary = failed.length ? failed[failed.length - 1] : null;

  const unknown_stuck_types = [...new Set(
    rounds.map((r) => r.stuck_type).filter((t) => t && !STUCK_TYPES.includes(t))
  )];

  const rec = {
    date: str(s.logged_at) || now.toISOString().slice(0, 19),
    student: str(s.student) || "default",
    topic: str(p.topic),
    skeleton_type: str(sk.type) || str(p.topic),
    skeleton_steps: Array.isArray(sk.steps) ? sk.steps.length : int(sk.steps),
    grade: str(p.grade),
    // 全文题干：维度一的"跨题型找共同特征"（隐性条件/运算选择/阅读量）必须有原文才能判，
    // 摘要不够。答疑场景一道题几十上百字，存全文成本可忽略。
    problem: str(p.text).slice(0, 2000),
    rounds,
    stuck_type: primary ? primary.stuck_type : "",
    stuck_step: primary ? primary.stuck_step : 0,
    rounds_count: rounds.length,
    inner_loop: int(s.inner_loop),
    escape_reason,
    // 干预后新题是否独立做对：最后一轮 correct 即为它；无干预时为 true。
    new_problem_independent_correct: rounds.length ? bool(rounds[rounds.length - 1].correct) : true,
  };
  if (unknown_stuck_types.length) rec.unknown_stuck_types = unknown_stuck_types;
  return rec;
}

export function appendLog(rec, logPath = DEFAULT_LOG) {
  fs.appendFileSync(logPath, JSON.stringify(rec) + "\n", "utf8");
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
  return lines.length;
}

function selftest() {
  const cases = [];
  const eq = (name, actual, expected) => cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  // 1) 全程没卡
  const clean = project({
    problem: { text: "头10脚26", topic: "鸡兔同笼", grade: "五年级" },
    skeleton: { type: "鸡兔同笼", steps: [1, 2, 3, 4, 5] },
    diagnosis: { correct: true }, inner_loop: 0, escape_reason: "",
  });
  eq("全程没卡·rounds 一条且 correct", clean.rounds.length === 1 && clean.rounds[0].correct, true);
  eq("全程没卡·无主卡点", clean.stuck_type, "");
  eq("全程没卡·骨架步数由数组长度得出", clean.skeleton_steps, 5);
  eq("全程没卡·题干存全文", clean.problem, "头10脚26");
  eq("全程没卡·默认学生名", clean.student, "default");

  // 2) 多轮：第1轮卡方法层→干预过了→新题独立做对
  const multi = project({
    problem: { text: "甲乙相向而行", topic: "相遇问题" },
    skeleton: { type: "相遇问题", steps: [1, 2, 3, 4] },
    rounds: [
      { correct: false, stuck_step: 2, stuck_type: "方法/概念偏差", detail: "用了速度差", intervene_attempts: 1, passed: true },
      { correct: true, stuck_step: 0, stuck_type: "", intervene_attempts: 0, passed: true },
    ],
    inner_loop: 1, escape_reason: "",
  });
  eq("多轮·保留两轮不压扁", multi.rounds_count, 2);
  eq("多轮·主卡点取最后一个未过轮次", multi.stuck_type, "方法/概念偏差");
  eq("多轮·新题独立做对", multi.new_problem_independent_correct, true);

  // 3) exhausted：反复没迈过
  const ex = project({
    problem: { text: "工程问题题干", topic: "工程问题" },
    skeleton: { type: "工程问题", steps: [1, 2, 3] },
    rounds: [
      { correct: false, stuck_step: 2, stuck_type: "审题理解错误", intervene_attempts: 3, passed: false },
      { correct: false, stuck_step: 2, stuck_type: "审题理解错误", intervene_attempts: 3, passed: false },
    ],
    inner_loop: 3, escape_reason: "exhausted",
  });
  eq("exhausted·escape_reason 透传", ex.escape_reason, "exhausted");
  eq("exhausted·新题未独立做对", ex.new_problem_independent_correct, false);
  eq("exhausted·审题理解错误是合法卡点", ex.unknown_stuck_types, undefined);

  // 4) 老 state（无 rounds）退化投影
  const legacy = project({
    problem: { text: "盈亏题", topic: "盈亏问题" },
    skeleton: { type: "盈亏问题", steps: 4 },
    diagnosis: { correct: false, step: 3, type: "计算失误", reason: "除错了" },
    intervene: { count: 1, passed: true }, inner_loop: 1, escape_reason: "",
  });
  eq("老state·退化成一条 round", legacy.rounds_count, 1);
  eq("老state·主卡点仍可得", legacy.stuck_type, "计算失误");
  eq("老state·steps 为数字时直接取", legacy.skeleton_steps, 4);

  // 5) 词表漂移要被标记出来（防止分析端拿到对不上的分类还不知情）
  const drift = project({
    problem: { text: "x", topic: "y" }, skeleton: { type: "y", steps: 3 },
    rounds: [{ correct: false, stuck_step: 1, stuck_type: "概念混淆", intervene_attempts: 1, passed: false }],
    inner_loop: 0, escape_reason: "",
  });
  eq("词表漂移·旧词被标记", drift.unknown_stuck_types, ["概念混淆"]);

  // 6) gave_up
  const gu = project({
    problem: { text: "z", topic: "w" }, skeleton: { type: "w", steps: 3 },
    rounds: [{ correct: false, stuck_step: 2, stuck_type: "无从下手", intervene_attempts: 0, passed: false }],
    inner_loop: 0, escape_reason: "gave_up",
  });
  eq("gave_up·escape_reason 透传", gu.escape_reason, "gave_up");

  // 7) 多学生分流
  const stu = project({ student: "小明", problem: { text: "a", topic: "b" }, skeleton: { type: "b", steps: 2 }, diagnosis: { correct: true } });
  eq("多学生·student 透传", stu.student, "小明");

  // 8) 空 state 不崩
  const empty = project({});
  eq("空state·不抛异常且 rounds 为空", empty.rounds_count, 0);

  // 9) 追加写入真能落盘且可被逐行解析
  const tmp = path.join(os.tmpdir(), `ai-teaching-log-selftest-${process.pid}.jsonl`);
  try {
    fs.rmSync(tmp, { force: true });
    appendLog(clean, tmp);
    const n = appendLog(multi, tmp);
    const parsed = fs.readFileSync(tmp, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    eq("落盘·两条记录", n, 2);
    eq("落盘·每行独立可解析", parsed.length === 2 && parsed[1].topic === "相遇问题", true);
    eq("落盘·题干无换行污染 JSONL", JSON.stringify(clean).includes("\n"), false);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  let pass = 0;
  for (const c of cases) {
    if (c.ok) pass++;
    console.log(`${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : `  → 期望 ${JSON.stringify(c.expected)}，实际 ${JSON.stringify(c.actual)}`}`);
  }
  console.log(`\n${pass}/${cases.length} 通过`);
  process.exit(pass === cases.length ? 0 : 1);
}

// ---- CLI ----
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const si = argv.indexOf("--state");
    const statePath = si >= 0 && argv[si + 1] ? argv[si + 1] : DEFAULT_STATE;
    const li = argv.indexOf("--log");
    const logPath = li >= 0 && argv[li + 1] ? argv[li + 1] : DEFAULT_LOG;
    const dry = argv.includes("--dry-run");

    if (!fs.existsSync(statePath)) {
      console.log(JSON.stringify({ ok: false, error: `state 文件不存在：${statePath}` }));
      process.exit(1);
    }
    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: `state 不是合法 JSON：${e.message}` }));
      process.exit(2);
    }
    const rec = project(state);
    if (dry) {
      console.log(JSON.stringify(rec));
    } else {
      try {
        const records = appendLog(rec, logPath);
        console.log(JSON.stringify({ ok: true, written: logPath.replace(HOME, "~"), records }));
      } catch (e) {
        console.log(JSON.stringify({ ok: false, error: `写日志失败：${e.message}` }));
        process.exit(3);
      }
    }
  }
}
