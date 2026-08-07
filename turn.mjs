// AI Teaching Engine · 每轮单次调用入口
//
// 为什么存在：过去每一轮宿主要依次做 4~5 件事——过守卫、追加 turn、更新 state、
// 自增 inner_loop / 追问计数、重写整页 HTML。件件都能忘，忘了就泄底或丢历史。
// 这里把一轮的全部动作合成一次原子调用：
//
//   guard（该审的阶段才审）→ 追加 turn → 推进计数器/escape_reason → 渲染面板
//
// 守卫不过就**什么都不写**（不落 state、不碰 HTML），并把 violations 回给宿主重写。
// 这样"ok=false 的文本绝不许发给学生或写进 HTML"从一条纪律变成一个不变量。
//
// 计数器（inner_loop、同一卡点追问次数、escape_reason）一律由本文件推进——
// 让 LLM 自己数数是经典失效点，它记不住第几次了。
//
// 用法：
//   node turn.mjs --turn-file /tmp/turn.json                 # turn 数据（含 body）从文件读，无需转义
//   node turn.mjs --turn-file /tmp/turn.json --phase-to practice
//   node turn.mjs --event intervene_failed                   # 只推进计数器，不追加 turn
//   node turn.mjs --selftest
//
// --turn-file 里就是要追加进 state.turns 的那条 turn 对象（结构见 render.mjs 头部注释），
// 可选多带一个 guard 上下文字段：
//   {"role":"teacher","phase":"explain","step":2,"body":"第2步：…\n引导：…","svg":"<svg…>",
//    "guard":{"final_answer":"3","problem_text":"头10脚26","prev_student":"…","round":1}}
//
// guard 上下文缺省时会自动从 state 里取（EXPLAIN 取 problem，PRACTICE 之后取本次练习题），
// 所以正常情况下宿主只需给 role/phase/body。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guard } from "./guard.mjs";
import { renderHtml, STATE_PATH, CARD_PATH } from "./render.mjs";
import { project, appendLog as appendLogLine } from "./log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HOME = os.homedir();
export const LOG_PATH = path.join(HOME, ".ai-teaching-log.jsonl");

// 需要过守卫的阶段。summarize/review 及学生/note turn 不审。
const AUDITED_PHASES = new Set(["explain", "practice", "diagnose", "intervene"]);

// 逃生阈值（与 SKILL.md 的 Escape Hatches 一致）
export const MAX_INNER_LOOP = 2;   // inner_loop > 2 → exhausted
export const MAX_INTERVENE = 3;    // 同一卡点追问 ≥3 次 → exhausted

const readState = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return { phase: "setup", turns: [] }; }
};

// 从 state 里推出守卫需要的上下文。
// 关键分工：EXPLAIN 讲的是原题 → 取 problem；PRACTICE 之后（诊断/干预）说的是变式题
// → 必须取 practice 的得数，否则守卫拿原题答案去查变式题，既漏检又误报。
//
// steps_solution + current_step 一起传，守卫据此保护"还没轮到的中间量"
// （追及距离/单价/总份数这类过程值，泄了比泄最终得数更致命）。
// 这里自动带上，宿主不需要记得传——记得传这件事本身就是要消除的失效点。
export function guardContext(state, phase, override = {}) {
  const s = state || {};
  const fromPractice = phase !== "explain";
  const src = fromPractice && s.practice?.final_answer ? s.practice : s.problem || {};

  // 「学生自己已说出的数字不算老师泄露」——学生的话有两个来源，必须都算：
  //   1. chat 里的发言（role:"student" 的 turn）
  //   2. **练习表单里填的作答**（进的是 state.practice.answers，不是 turn）
  // 只看 1 的话，诊断阶段肯定学生算对的中间量（"你第2步的455算对了"）会被误判成泄底，
  // 而那恰恰是诊断最自然的写法 —— 实测平均数问题就在这里被整局拦住。
  const lastChat = [...(s.turns || [])].reverse().find((t) => t?.role === "student")?.body || "";
  const formAnswers = Object.values(s.practice?.answers || {}).join(" ");
  const prevStudent = [lastChat, formAnswers].filter(Boolean).join(" ");

  // 当前讲到第几步：EXPLAIN 用 explain.step；练习之后的阶段围绕诊断出的卡点步展开
  const currentStep = fromPractice
    ? (s.diagnosis?.step ?? s.intervene?.stuck_step ?? 0) || 0
    : (s.explain?.step ?? 0) || 0;
  return {
    final_answer: src.final_answer || "",
    problem_text: (fromPractice ? s.practice?.story : s.problem?.text) || s.problem?.text || "",
    prev_student: prevStudent,
    round: (s.explain?.step ?? 0) || 0,
    steps_solution: src.steps_solution || "",
    current_step: currentStep,
    ...override,
  };
}

// 计数器推进。返回改了哪些字段，供调用方回显。
// exhausted 的两条触发路径都收在这里，LLM 不必自己判阈值。
// 同时回填 rounds 末条的 intervene_attempts/passed —— 那是 math-analytics 的输入，
// 靠散文要求 LLM"记得回填"必然漏，和计数器是同一类失效。
export function advance(state, event) {
  const s = state;
  s.intervene = s.intervene || { stuck_type: "", stuck_step: 0, count: 0, question: "" };
  s.rounds = Array.isArray(s.rounds) ? s.rounds : [];
  const last = s.rounds.length ? s.rounds[s.rounds.length - 1] : null;
  const changed = {};

  switch (event) {
    case "intervene_passed":
      // 迈过卡点 → inner_loop++ → 出新题回 PRACTICE；超阈值则逼出本题
      s.intervene.count = (s.intervene.count || 0) + 1;
      s.intervene.passed = true;
      if (last) {
        last.intervene_attempts = s.intervene.count;
        last.passed = true;
        changed.rounds_backfilled = s.rounds.length;
      }
      s.inner_loop = (s.inner_loop || 0) + 1;
      changed.inner_loop = s.inner_loop;
      s.intervene.count = 0;
      if (s.inner_loop > MAX_INNER_LOOP) {
        s.escape_reason = "exhausted";
        s.phase = "review";
        changed.escape_reason = "exhausted";
        changed.phase = "review";
      } else {
        s.phase = "practice";
        changed.phase = "practice";
      }
      break;

    case "intervene_failed":
      // 同一卡点没迈过 → 追问计数++ → 满 3 次逼出本题
      s.intervene.count = (s.intervene.count || 0) + 1;
      s.intervene.passed = false;
      changed.intervene_count = s.intervene.count;
      if (last) {
        last.intervene_attempts = s.intervene.count;
        last.passed = false;
      }
      if (s.intervene.count >= MAX_INTERVENE) {
        s.escape_reason = "exhausted";
        s.phase = "review";
        changed.escape_reason = "exhausted";
        changed.phase = "review";
      }
      break;

    case "gave_up":
      s.escape_reason = "gave_up";
      s.phase = "review";
      changed.escape_reason = "gave_up";
      changed.phase = "review";
      break;

    case "correct":
      s.phase = "review";
      changed.phase = "review";
      break;

    default:
      return { error: `未知 event：${event}（可用：intervene_passed|intervene_failed|gave_up|correct）` };
  }
  return changed;
}

// 一轮的原子提交：审 → 写 state → 渲染 HTML。
// 守卫不过 → 立刻返回，state 与 HTML 都不动（这是本文件存在的主要意义）。
export function commit({
  turn = null, event = "", phaseTo = "", answers = null,
  statePath = STATE_PATH, outPath = CARD_PATH, dryRun = false,
} = {}) {
  const state = readState(statePath);
  state.turns = Array.isArray(state.turns) ? state.turns : [];

  // 1) 守卫：只审"要发给学生看的教学文本"
  let guardResult = { ok: true, violations: [], audited: false };
  if (turn && turn.body && AUDITED_PHASES.has(turn.phase) && turn.role !== "student") {
    const ctx = guardContext(state, turn.phase, turn.guard || {});
    guardResult = guard({ text: turn.body, phase: turn.phase, ...ctx });
    if (!guardResult.ok) {
      return {
        ok: false, wrote: false, guard: guardResult,
        hint: "命中教学红线：针对 violations 重写这段话再提交。state 与面板都未改动，可直接重试。",
      };
    }
  }
  // 出题题干同样要审：practice turn 的 story 是发给学生看的
  if (turn && turn.phase === "practice" && turn.story && !turn.answers) {
    const ctx = guardContext(state, "practice", turn.guard || {});
    // 出题时得数与标准过程取本次新题自带的（还没写进 state）
    if (turn.final_answer) ctx.final_answer = turn.final_answer;
    if (turn.steps_solution) ctx.steps_solution = turn.steps_solution;
    ctx.problem_text = turn.story;
    ctx.current_step = 0;   // 新题还没开讲，全部中间量都不许出现在题干里
    const r = guard({ text: turn.story, phase: "practice", ...ctx });
    if (!r.ok) {
      return { ok: false, wrote: false, guard: r, hint: "出题题干泄题：重写 story 再提交。" };
    }
    guardResult = { ...r, audited: true };
  }

  // 2) 追加 / 更新 turn
  let appended = false;
  if (answers) {
    // 学生提交作答：给最后一个未提交的练习 turn 补 answers（不新增 turn）
    const live = [...state.turns].reverse().find((t) => t?.phase === "practice" && !t.answers);
    if (!live) return { ok: false, wrote: false, error: "没有待作答的练习表单，answers 无处可挂" };
    live.answers = answers;
    state.practice = { ...(state.practice || {}), answers };
  } else if (turn) {
    // guard 上下文与诊断原始 JSON 都不进 turns（前者是调用参数，后者投影进 rounds 后
    // 留在 state.diagnosis；turns 里只放渲染要用的东西）
    const { guard: _drop, diagnosis: _diag, final_answer: _fa, steps_solution: _ss, ...clean } = turn;
    state.turns.push(clean);
    appended = true;
    // 练习题的得数/标准过程存进 state，供之后诊断与守卫取用
    if (turn.phase === "practice" && turn.final_answer) {
      state.practice = {
        ...(state.practice || {}),
        story: turn.story, final_answer: turn.final_answer,
        steps_solution: turn.steps_solution || "",
      };
    }
    if (turn.phase === "explain" && turn.step) {
      state.explain = { ...(state.explain || {}), step: turn.step };
    }
    // 诊断出结果 → 自动追加一条 rounds（一道题可能多轮，每轮一条）。
    // 诊断字段跟着 turn 一起传（diagnosis:{correct,step,type,reason}），
    // 由脚本投影成 rounds 条目，宿主不必自己维护这个数组。
    if (turn.phase === "diagnose" && turn.diagnosis) {
      const d = turn.diagnosis;
      state.diagnosis = d;
      state.rounds = Array.isArray(state.rounds) ? state.rounds : [];
      state.rounds.push({
        correct: !!d.correct,
        stuck_step: d.step ?? 0,
        stuck_type: d.type || "",
        detail: d.reason || "",
        intervene_attempts: 0,
        passed: !!d.correct,
      });
      state.intervene = {
        ...(state.intervene || {}),
        stuck_type: d.type || "", stuck_step: d.step ?? 0, count: 0,
      };
    }
  }

  // 3) 计数器 / 阶段推进
  const advanced = event ? advance(state, event) : {};
  if (advanced.error) return { ok: false, wrote: false, error: advanced.error };
  if (phaseTo && !advanced.phase) state.phase = phaseTo;

  // 4) 渲染面板
  const html = renderHtml(state);
  if (dryRun) {
    return { ok: true, wrote: false, dryRun: true, guard: guardResult, appended, advanced, phase: state.phase, turns: state.turns.length, html };
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");

  return {
    ok: true, wrote: true, guard: guardResult, appended, advanced,
    phase: state.phase, turns: state.turns.length,
    card: outPath.replace(HOME, "~"),
  };
}

// 学情日志由 log.mjs 负责（它做完整投影：rounds 多轮、student 分流、卡点词表校验）。
// 这里只做转发，方便"一轮一个入口"的调用习惯：node turn.mjs --log
// 真正的字段契约在 log.mjs，不要在这里另写一份投影——两份必然漂移。
export function writeLog({ statePath = STATE_PATH, logPath = LOG_PATH } = {}) {
  const state = readState(statePath);
  const rec = project(state);
  const records = appendLogLine(rec, logPath);
  return { ok: true, written: logPath.replace(HOME, "~"), records, entry: rec };
}

// ---- CLI ----

const HELP = `AI Teaching Engine · 每轮单次调用（守卫 + 落盘 + 渲染 + 计数）

追加一条 turn（推荐：turn 数据写进文件，body 含换行无需转义）：
  node turn.mjs --turn-file /tmp/turn.json [--phase-to <phase>]

正文另放纯文本文件（最稳，JSON 里不必转义换行）：
  node turn.mjs --turn-file /tmp/turn.json --body-file /tmp/body.txt
  # turn.json 只留结构字段：{"role":"teacher","phase":"explain","step":2,"svg":"<svg…>"}

学生提交练习作答（挂到最后一个未提交的表单上，不新增 turn）：
  node turn.mjs --answers-file /tmp/answers.json

只推进计数器（不追加 turn）：
  node turn.mjs --event intervene_passed|intervene_failed|gave_up|correct

复盘完成后写学情日志：
  node turn.mjs --log

其它：--dry-run 只校验和渲染、不落盘   --state <p> --out <p>   --selftest   --help

守卫不过时：返回 ok:false + violations，且 state 与面板都不改动 —— 重写文本后原样重试即可。
退出码：0 = 成功，1 = 命中红线，2 = 用法/输入错误`;

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ate-"));
  const sp = path.join(tmp, "state.json");
  const op = path.join(tmp, "card.html");
  const lp = path.join(tmp, "log.jsonl");
  const cases = [];
  const t = (name, cond) => cases.push({ name, cond });

  const seed = (extra = {}) => fs.writeFileSync(sp, JSON.stringify({
    phase: "explain", problem: { topic: "鸡兔同笼", text: "头10脚26", final_answer: "3" },
    skeleton: { type: "鸡兔同笼", steps: [1, 2, 3] }, turns: [], inner_loop: 0,
    intervene: { count: 0 }, ...extra,
  }));

  // 守卫拦截 → 一个字节都不许写
  seed();
  const before = fs.readFileSync(sp, "utf8");
  const blocked = commit({ turn: { role: "teacher", phase: "explain", body: "所以兔子就是3只啦。" }, statePath: sp, outPath: op });
  t("泄底被拦下", blocked.ok === false && blocked.guard.violations.length > 0);
  t("拦下时 state 未改动", fs.readFileSync(sp, "utf8") === before);
  t("拦下时不生成面板", !fs.existsSync(op));

  // 干净文本 → 写 state + 渲染
  const good = commit({ turn: { role: "teacher", phase: "explain", step: 2, body: "第2步：假设全是鸡。\n引导：一共几条腿？" }, statePath: sp, outPath: op });
  t("干净文本通过并落盘", good.ok && good.wrote && good.appended);
  t("面板已生成且含正文", fs.existsSync(op) && fs.readFileSync(op, "utf8").includes("一共几条腿"));
  t("explain.step 被记下", readState(sp).explain?.step === 2);

  // 复述题干给定条件不算泄底
  t("复述题干条件放行", commit({ turn: { role: "teacher", phase: "explain", body: "第1步：题目说有10个头、26条腿。\n引导：哪个是头？" }, statePath: sp, outPath: op }).ok);

  // 出题：题干泄题要拦
  t("出题题干点明运算被拦",
    commit({ turn: { phase: "practice", story: "把两个速度相加，一共走多远？", final_answer: "60", steps: [] }, statePath: sp, outPath: op }).ok === false);

  // 出题：干净题干 → practice 存进 state
  const pr = commit({ turn: { phase: "practice", form_id: "p1", story: "笼子里有8个头22条腿", final_answer: "兔3只鸡5只", steps_solution: "1;2;3", steps: [{ id: 1, type: "fill", q: "兔子几只？" }] }, statePath: sp, outPath: op, phaseTo: "practice" });
  t("干净出题通过", pr.ok && pr.phase === "practice");
  t("practice 得数写进 state", readState(sp).practice?.final_answer === "兔3只鸡5只");
  t("表单渲染出来了", fs.readFileSync(op, "utf8").includes('<form id="practice"'));

  // 诊断阶段的守卫上下文必须切到变式题得数（原题得数是 3，变式题是"兔3只鸡5只"）
  t("诊断泄露变式题得数被拦",
    commit({ turn: { phase: "diagnose", body: "第2步错了，应该是兔3只鸡5只。" }, statePath: sp, outPath: op }).ok === false);

  // 学生提交作答 → 挂到表单上，不新增 turn
  const nBefore = readState(sp).turns.length;
  const sub = commit({ answers: { 1: "5只" }, statePath: sp, outPath: op });
  t("作答挂上表单且不新增 turn", sub.ok && readState(sp).turns.length === nBefore);
  t("表单变成已提交回顾", !fs.readFileSync(op, "utf8").includes('<form id="practice"'));
  t("回显学生答案", fs.readFileSync(op, "utf8").includes("你的答案：5只"));
  t("重复提交作答会报错", commit({ answers: { 1: "x" }, statePath: sp, outPath: op }).ok === false);

  // 计数器：追问三次触发 exhausted
  seed({ intervene: { count: 0 } });
  commit({ event: "intervene_failed", statePath: sp, outPath: op });
  const c2 = commit({ event: "intervene_failed", statePath: sp, outPath: op });
  t("追问 2 次还不逃生", c2.phase !== "review" && readState(sp).intervene.count === 2);
  const c3 = commit({ event: "intervene_failed", statePath: sp, outPath: op });
  t("追问满 3 次 → exhausted + review", c3.phase === "review" && readState(sp).escape_reason === "exhausted");

  // 计数器：inner_loop 超阈值触发 exhausted
  seed({ inner_loop: 0 });
  const p1 = commit({ event: "intervene_passed", statePath: sp, outPath: op });
  t("迈过卡点 → inner_loop=1 回 practice", p1.phase === "practice" && readState(sp).inner_loop === 1);
  commit({ event: "intervene_passed", statePath: sp, outPath: op });
  const p3 = commit({ event: "intervene_passed", statePath: sp, outPath: op });
  t("inner_loop>2 → exhausted", p3.phase === "review" && readState(sp).escape_reason === "exhausted");

  seed();
  t("gave_up → review", commit({ event: "gave_up", statePath: sp, outPath: op }).phase === "review" && readState(sp).escape_reason === "gave_up");
  seed();
  const corr = commit({ event: "correct", statePath: sp, outPath: op });
  t("correct → review 且 escape_reason 为空", corr.phase === "review" && !readState(sp).escape_reason);
  t("未知 event 报错", commit({ event: "zzz", statePath: sp, outPath: op }).ok === false);

  // dry-run 不落盘
  seed();
  const snap = fs.readFileSync(sp, "utf8");
  const dry = commit({ turn: { role: "note", body: "x" }, statePath: sp, outPath: op, dryRun: true });
  t("dry-run 返回 html 但不写 state", dry.ok && !dry.wrote && dry.html.includes("<!DOCTYPE") && fs.readFileSync(sp, "utf8") === snap);

  // 学情日志
  seed({ diagnosis: { step: 4, type: "方法/概念偏差", reason: "用头数而非差额" }, intervene: { count: 1, passed: true }, inner_loop: 1, escape_reason: "" });
  writeLog({ statePath: sp, logPath: lp });
  writeLog({ statePath: sp, logPath: lp });
  const lines = fs.readFileSync(lp, "utf8").trim().split("\n");
  // 字段契约来自 log.mjs 的投影：主卡点在顶层 stuck_type（不是嵌套的 diagnosis.stuck_type）
  t("日志两条、每条一行 JSONL", lines.length === 2 && JSON.parse(lines[0]).stuck_type === "方法/概念偏差");
  t("日志含 escape_reason 字段", "escape_reason" in JSON.parse(lines[1]));
  t("日志把单轮 diagnosis 投影成 rounds", JSON.parse(lines[0]).rounds_count === 1);
  t("日志含 student 分流字段", JSON.parse(lines[0]).student === "default");

  // rounds 生命周期：诊断自动追加、干预自动回填，全程 LLM 不碰这个数组
  seed();
  commit({ turn: { phase: "diagnose", body: "你第4步卡住了，差额方向反了。", diagnosis: { correct: false, step: 4, type: "方法/概念偏差", reason: "用头数而非差额" } }, statePath: sp, outPath: op });
  const r1 = readState(sp);
  t("诊断自动追加 rounds 一条", r1.rounds?.length === 1 && r1.rounds[0].stuck_type === "方法/概念偏差");
  t("诊断原始 JSON 不进 turns，只留 state.diagnosis",
    !("diagnosis" in r1.turns[r1.turns.length - 1]) && r1.diagnosis.step === 4);
  t("诊断把卡点写进 intervene 并归零计数", r1.intervene.stuck_step === 4 && r1.intervene.count === 0);
  commit({ event: "intervene_failed", statePath: sp, outPath: op });
  commit({ event: "intervene_passed", statePath: sp, outPath: op });
  const r2 = readState(sp);
  t("干预自动回填 rounds 末条 attempts/passed",
    r2.rounds[0].passed === true && r2.rounds[0].intervene_attempts === 2);
  const l2 = path.join(tmp, "log2.jsonl");
  writeLog({ statePath: sp, logPath: l2 });
  const rec2 = JSON.parse(fs.readFileSync(l2, "utf8").trim());
  t("回填后的 rounds 进得了日志", rec2.rounds[0].intervene_attempts === 2 && rec2.rounds[0].passed === true);

  // 中间量保护：表单作答也算"学生自己已说出"。
  // 诊断阶段肯定学生填对的中间量（"你第2步的455算对了"）是最自然的写法，
  // 若只把 chat 发言算作学生的话，这里会必然误报、整局教学被拦住（实测平均数问题）。
  seed({
    problem: { topic: "平均数", text: "前4次平均90个，第5次95个", final_answer: "91个", steps_solution: "2总数=360+95=455;3=455÷5=91个" },
    practice: { story: "前4次平均90个，第5次95个", final_answer: "91个", steps_solution: "2总数=455;3=91个", answers: { 1: "4", 2: "455个", 3: "113.75个" } },
    diagnosis: { step: 1 },
  });
  const cite = commit({ turn: { phase: "diagnose", body: "第2步总数你算对了，455个没问题。第1步再想想除以几？", diagnosis: { correct: false, step: 1, type: "审题理解错误", reason: "份数数错" } }, statePath: sp, outPath: op });
  t("诊断引用学生表单填对的中间量不误报", cite.ok === true);
  t("误报被修掉后 rounds 正常落条", readState(sp).rounds?.length === 1);
  // 但学生没填过的中间量仍要拦
  seed({
    problem: { topic: "平均数", text: "前4次平均90个，第5次95个", final_answer: "91个", steps_solution: "2总数=360+95=455;3=455÷5=91个" },
    practice: { story: "前4次平均90个，第5次95个", final_answer: "91个", steps_solution: "2总数=455;3=91个", answers: { 1: "4", 2: "没算出来", 3: "" } },
    diagnosis: { step: 2 },
  });
  t("学生没填过的中间量仍被拦",
    commit({ turn: { phase: "diagnose", body: "第2步的总数应该是455个。你再看看？", diagnosis: { correct: false, step: 2, type: "过程跳步", reason: "x" } }, statePath: sp, outPath: op }).ok === false);

  // --body-file：正文走纯文本，含换行也不必转义（回归 e2e 里踩到的"JSON 非法"陷阱）
  seed();
  const bf = path.join(tmp, "body.txt");
  const tf = path.join(tmp, "turn.json");
  fs.writeFileSync(bf, "第1步：一共10个头、26条腿。\n引导：哪个数是动物只数？\n");
  fs.writeFileSync(tf, JSON.stringify({ role: "teacher", phase: "explain", step: 1 }));
  const bodyRun = execFileSync("node", [
    path.join(HERE, "turn.mjs"), "--turn-file", tf, "--body-file", bf,
    "--state", sp, "--out", op,
  ], { encoding: "utf8" });
  t("--body-file 提交成功", JSON.parse(bodyRun).ok === true);
  t("--body-file 的换行原样进 state",
    readState(sp).turns[0].body === "第1步：一共10个头、26条腿。\n引导：哪个数是动物只数？");

  fs.rmSync(tmp, { recursive: true, force: true });

  let pass = 0;
  for (const c of cases) {
    if (c.cond) pass++;
    console.log(`${c.cond ? "✅" : "❌"} ${c.name}`);
  }
  console.log(`\n${pass}/${cases.length} 通过`);
  process.exit(pass === cases.length ? 0 : 1);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n, d = "") => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
  const die = (rule, evidence = "") => { console.log(JSON.stringify({ ok: false, error: rule, evidence })); process.exit(2); };

  if (argv.includes("--selftest")) selftest();
  else if (argv.includes("--help") || argv.includes("-h")) console.log(HELP);
  else {
    const statePath = flag("--state", STATE_PATH);
    const outPath = flag("--out", CARD_PATH);
    const readJson = (p, label) => {
      try { return JSON.parse(fs.readFileSync(p, "utf8")); }
      catch (e) { die(`读不到/解析不了 ${label}`, e.message); }
    };

    if (argv.includes("--log")) {
      console.log(JSON.stringify(writeLog({ statePath, logPath: flag("--log-path", LOG_PATH) })));
    } else {
      const turnFile = flag("--turn-file");
      const bodyFile = flag("--body-file");
      const answersFile = flag("--answers-file");
      const event = flag("--event");
      if (!turnFile && !answersFile && !event) die("用法错误", "至少给 --turn-file / --answers-file / --event 之一（看 --help）");

      let turnObj = turnFile ? readJson(turnFile, "--turn-file") : null;
      // body 是唯一必然含换行的字段，放进 JSON 就又要转义（写错就是"非法 JSON"）。
      // --body-file 让正文走纯文本文件、JSON 里只留结构字段，彻底绕开这个坑。
      if (bodyFile) {
        if (!turnObj) turnObj = {};
        try { turnObj.body = fs.readFileSync(bodyFile, "utf8").replace(/\n+$/, ""); }
        catch (e) { die("读不到 --body-file", e.message); }
      }

      const result = commit({
        turn: turnObj,
        answers: answersFile ? readJson(answersFile, "--answers-file") : null,
        event, phaseTo: flag("--phase-to"),
        statePath, outPath, dryRun: argv.includes("--dry-run"),
      });
      const { html: _h, ...printable } = result;
      console.log(JSON.stringify(printable, null, 2));
      // 退出码要能区分两种失败：命中红线（1，改文本重试）vs 调用/状态错误（2，改调用姿势）。
      // 混在一起会让宿主把"没有待作答的表单"当成"这段话泄底了"，白改一轮文本。
      if (result.ok) process.exit(0);
      process.exit(result.guard && result.guard.ok === false ? 1 : 2);
    }
  }
}
