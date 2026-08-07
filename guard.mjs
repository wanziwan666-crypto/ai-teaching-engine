// AI Teaching Engine · 运行时守卫（安全网）
//
// 用途：每一轮把「即将发给孩子的文本」在回复前过一遍这里，命中红线就重生成。
// 规则移植自 demo 的 test/selftest.mjs 审计函数，但去掉了相遇问题的硬编码，
// 改成对任意题型都成立的通用检查（靠传入的 standard_answer 判泄底，而非正则相遇/靠近）。
//
// 用法：
//   推荐（无需转义，教学文本含换行也不会出问题）：
//     node guard.mjs --text-file /tmp/t.txt --phase explain --final-answer 3 --problem-text "头10脚26"
//   向后兼容（stdin 传 JSON；注意换行必须正确转义，见 --help）：
//     node guard.mjs < payload.json
//   node guard.mjs --selftest   跑内置样例
//
// 泄底检测的数字来源（务必分清三种角色，否则会大量误报）：
//   - final_answer ：最终得数，唯一「不许老师抢先说出」的数字。首选传这个。
//   - problem_text ：题干原文，里面的数字是「给定条件」，老师可自由复述 → 从泄底名单里减掉。
//   - standard_answer：向后兼容字段。若没传 final_answer，退回用它抽数字，但会减掉 problem_text
//                      里的给定条件、并剥掉「第N步」步号，尽量降噪。仍建议改传 final_answer。

import fs from "node:fs";

const firstLine = (t) => ((t || "").trim().split("\n").find((l) => l.trim()) || (t || "").trim()).slice(0, 120);
const lastLine = (t) => ((t || "").trim().split("\n").filter((l) => l.trim()).pop() || "").slice(0, 120);
function matchLine(text, re) {
  const m = (text || "").match(re);
  return m ? m[0].slice(0, 120) : "";
}

// 抽出一段文本里的所有数字（整数/小数），去重保留原串。
function numbersIn(s) {
  if (!s) return [];
  return [...new Set(String(s).match(/\d+(?:\.\d+)?/g) || [])];
}

// 把「第N步 / 第一步」这类步号从文本里抹掉，免得步号数字被当成得数误报。
const STEP_TOKEN = /第\s*[一二三四五六七八九十0-9]+\s*步/g;
function stripStepTokens(s) {
  return String(s || "").replace(STEP_TOKEN, "");
}

// 计算「绝不许老师抢先说出」的得数名单：
//   优先用 final_answer；没有则退回 standard_answer（并剥掉步号）。
//   再减掉 problem_text 里的给定条件——那些数字老师本来就能复述。
function leakNumbers({ final_answer, standard_answer, problem_text }) {
  const source = final_answer || stripStepTokens(standard_answer);
  const givens = new Set(numbersIn(problem_text));
  return numbersIn(source).filter((n) => !givens.has(n));
}

// 计算「还没轮到、老师不许提前说出」的**中间量**名单。
//
// 为什么要单独保护中间量：final_answer 保护的是最终得数，而那恰恰是价值最低的数字——
// 学生推到那一步时该学的已经学到了。真正是全题洞察的是中间量
// （追及距离 180、和差问题"减掉差之后的 36"、归一的单价 3、按比例的总份数 5），
// 泄露它等于把该步的思考直接跳过，而这类写法（"一共是5份"、"每份其实是10元"）
// 读起来像老师在小结，LLM 很自然会写出来。实测四个题型全部可复现。
//
// 只保护 **current_step 及其之后** 的步骤：已经讲完的步骤，学生本来就已经想过、
// 甚至自己算出来了，老师复述是正当引导。这条范围限制是误报防线的主要来源。
// current_step 缺省（0）时保守起见保护全部中间量。
function pendingNumbers({ steps_solution, problem_text, current_step = 0 }) {
  const src = String(steps_solution || "");
  if (!src.trim()) return [];
  const givens = new Set(numbersIn(problem_text));
  // steps_solution 形如 "1同向;2追及距离=45×4=180米;3速度差;4=60-40=20;5=200÷20=10分钟"
  // 按分隔符切片，片段开头的数字是步号。取不出步号的片段归为"未知步"，一律保护。
  const pending = new Set();   // current_step 及之后出现的数字
  const settled = new Set();   // 已讲过的步骤里出现过的数字
  for (const seg of src.split(/[;；\n]/)) {
    const s = seg.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*[.、:：]?\s*(.*)$/);
    const stepNo = m ? Number(m[1]) : 0;
    const body = m ? m[2] : s;
    const done = stepNo && current_step && stepNo < current_step;
    for (const n of numbersIn(body)) {
      if (givens.has(n)) continue;
      (done ? settled : pending).add(n);
    }
  }
  // 已在早前步骤确立的值不再保护——它会自然地重新出现在后续步骤的算式里
  // （如"每份10元"在第4步的 10×2=20 中再次出现），而学生此时早已知道它，
  // 老师复述是正当引导。不减掉这批数字，主要的误报防线就形同虚设。
  return [...pending].filter((n) => !settled.has(n));
}

// 某个数值在 text 里以「独立数字」形式出现（前后都不是数字，避免 3 命中 13/30）
function appearsAsNumber(text, num) {
  return new RegExp(`(?<!\\d)${num.replace(".", "\\.")}(?!\\d)`).test(text || "");
}

// ---- 通用红线（各阶段共用） ----

// 拿名词术语考学生（题型无关）
const NAME_TRAPS = [
  /这.{0,4}(是什么|属于什么).{0,4}(题型|问题)/,
  /(叫什么|怎么称呼|叫做什么).{0,3}(速度|数|量|关系)?/,
  /你知道.{0,6}叫什么/,
  /(在数学上|专业上|术语).{0,4}叫什么/,
];
function checkNameTrap(text, flag) {
  for (const re of NAME_TRAPS) {
    if (re.test(text)) { flag("拿名词术语考学生", matchLine(text, re)); break; }
  }
}

// 一次回复输出多个"第 N 步"
function checkMultiStep(text, flag) {
  const n = (text.match(/第\s*[一二三四五六1-9]\s*步/g) || []).length;
  if (n >= 2) flag(`一次回复出现 ${n} 个"第 N 步"`, firstLine(text));
}

// 老师抢在学生前面报出了最终得数（题型无关）。
// 只查真正的得数（leakNumbers 已减掉题干给定条件、剥掉步号）；
// 学生自己已经说出的数字不算老师泄底。同样只在扫描前把步号从待查文本里抹掉。
function checkAnswerLeak(text, ctx, flag) {
  const scanText = stripStepTokens(text);
  for (const num of leakNumbers(ctx)) {
    if (num.length < 1) continue;
    if (appearsAsNumber(scanText, num) && !appearsAsNumber(ctx.prev_student, num)) {
      flag("抢在学生前面报出了最终得数", `含"${num}"：${matchLine(scanText, new RegExp(`.{0,10}${num.replace(".", "\\.")}.{0,10}`))}`);
      break;
    }
  }
}

// 含具体数字算式（如 6÷2、8*2），等于把运算方向/结果给了学生。
//
// 运算符必须收全宽/排印变体：中文教学文本里 LLM 很自然会写出「60−40」（U+2212 真减号）、
// 「60－40」（U+FF0D 全宽）而不是 ASCII 的「60-40」。只认 ASCII 的话这些全部漏检——
// 写「追及问题」骨架时正是这样漏掉了一条含算式的讲解文本。
// 加号/乘号/除号同理（＋／✕／∗ 等）。
const OPS = [
  "+", "＋", "﹢",                       // 加
  "-", "−", "－", "﹣", "‐", "–", "—",   // 减：ASCII / U+2212 / 全宽 / 小字form / 连字符 / en/em dash
  "×", "*", "＊", "✕", "∗", "·",         // 乘
  "÷", "／", "∕",                        // 除（斜杠 "/" 另行处理，见下）
];
const OP_CLASS = `[${OPS.map((c) => c.replace(/[\\\]^-]/g, "\\$&")).join("")}]`;
const EQUATION_RE = new RegExp(`\\d+\\s*${OP_CLASS}\\s*\\d+`);

// 斜杠要单独处理：`2/5` 在中文数学语境里几乎总是**分数**（"看了全书的2/5"），
// 不是"2 除以 5"这个算式。把它一律当算式，会让任何分数题型连复述题干都过不去
// ——分数应用题实测就是整个骨架不可用。
// 所以：裸分数放行，但分数**参与运算**时仍要拦（`60×3/4`、`1-2/5` 都是给了运算方向）。
// 判据：斜杠两侧的数字若紧邻另一个运算符，就不是单纯的分数。
const SLASH_IN_OPERATION = new RegExp(`(?:\\d\\s*${OP_CLASS}\\s*\\d+\\s*\\/|\\/\\s*\\d+\\s*${OP_CLASS}\\s*\\d)`);

function checkEquation(text, flag) {
  const eq = text.match(EQUATION_RE) || text.match(SLASH_IN_OPERATION);
  if (eq) flag("出现具体数字算式，泄露了运算方向或结果", eq[0] + " ← " + matchLine(text, new RegExp(`.{0,8}${eq[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.{0,8}`)));
}

// 老师抢在学生前面说出了**还没轮到的中间量**（如追及距离、单价、总份数）。
// 与 checkAnswerLeak 同源但保护的是过程值；学生自己已说出的不算泄露。
function checkIntermediateLeak(text, ctx, flag) {
  const scanText = stripStepTokens(text);
  for (const num of pendingNumbers(ctx)) {
    if (!num) continue;
    // 得数已由 checkAnswerLeak 负责，这里不重复报同一个数字
    if (appearsAsNumber(ctx.final_answer, num)) continue;
    if (appearsAsNumber(scanText, num) && !appearsAsNumber(ctx.prev_student, num)) {
      flag("抢在学生前面说出了这一步的中间量", `含"${num}"：${matchLine(scanText, new RegExp(`.{0,10}${num.replace(".", "\\.")}.{0,10}`))}`);
      break;
    }
  }
}

// ---- 各阶段审计 ----

// 讲：不给算式、一次一步、不考术语、不抢报答案/中间量
function auditExplain(text, ctx, flag) {
  checkNameTrap(text, flag);
  checkMultiStep(text, flag);
  checkEquation(text, flag);
  checkAnswerLeak(text, ctx, flag);
  checkIntermediateLeak(text, ctx, flag);
  // 首轮学生还没作答就给提示
  if (ctx.round === 1 && /提示[:：]/.test(text)) {
    flag("学生还没作答就给了提示", matchLine(text, /提示[:：].*/));
  }
}

// 练：出题题干不能含算式、不能点明运算方向、不能抢报答案
function auditPractice(text, ctx, flag) {
  checkEquation(text, flag);
  const hint = text.match(/(相加|相减|速度和|速度差|加起来|减掉|乘起来|除以)/);
  if (hint) flag("题干直接点明了运算方向", hint[0] + " ← " + matchLine(text, new RegExp(`.{0,10}${hint[0]}.{0,10}`)));
  checkAnswerLeak(text, ctx, flag);
  checkIntermediateLeak(text, ctx, flag);
}

// 诊断：只说"第几步错、错在哪"，不给正确算式/答案/中间量
function auditDiagnose(text, ctx, flag) {
  checkEquation(text, flag);
  checkAnswerLeak(text, ctx, flag);
  checkIntermediateLeak(text, ctx, flag);
}

// 干预：可给方向和依据，但不给算式/答案/中间量；结尾要把球踢回给学生
function auditIntervene(text, ctx, flag) {
  checkEquation(text, flag);
  checkAnswerLeak(text, ctx, flag);
  checkIntermediateLeak(text, ctx, flag);
  // 结尾应把问题抛回给学生：末段要有问号或"说说/试试/算算/写出"这类邀答祈使
  const tail = text.trim().replace(/[\s*`_>#-]+$/g, "").slice(-60);
  const invites = /[?？]|说说|试试|算算|写出|列.{0,2}算式|重.{0,2}(算|答|做)|你.{0,4}(怎么|该).{0,4}(算|想|做)/;
  if (!invites.test(tail)) {
    flag("结尾没把问题抛回给学生（无问句也无'说说/试试'类邀答）", lastLine(text));
  }
}

const AUDITORS = { explain: auditExplain, practice: auditPractice, diagnose: auditDiagnose, intervene: auditIntervene };

// 不需要审计的阶段（教学收尾/复盘/纯 state 写入）——放行而不是报"未知阶段"。
const UNAUDITED = new Set(["summarize", "review"]);

// 主入口：给一段待发文本 + 阶段 + 上下文，返回 {ok, violations, audited}
export function guard({ text = "", phase = "explain", final_answer = "", standard_answer = "", problem_text = "", prev_student = "", round = 0, steps_solution = "", current_step = 0 } = {}) {
  const violations = [];
  const flag = (rule, evidence) => violations.push({ rule, evidence });
  // 明确不审计的阶段：直接放行，标 audited:false，方便调用方区分"过了"和"没查"。
  if (UNAUDITED.has(phase)) return { ok: true, violations: [], audited: false };
  const auditor = AUDITORS[phase];
  if (!auditor) return { ok: false, violations: [{ rule: "未知阶段", evidence: String(phase) }], audited: false };
  auditor(text, { final_answer, standard_answer, problem_text, prev_student, round, steps_solution, current_step }, flag);
  return { ok: violations.length === 0, violations, audited: true };
}

// ---- 内置自测 ----
function selftest() {
  const cases = [
    { name: "讲·干净引导应通过", input: { text: "第2步：假设10只全是鸡。\n引导：那一共该有多少条腿呢？你算算看。", phase: "explain", standard_answer: "3" }, expectOk: true },
    { name: "讲·含算式应命中", input: { text: "第2步：假设全是鸡。引导：6÷2等于几？", phase: "explain", standard_answer: "3" }, expectOk: false },
    { name: "讲·一次多步应命中", input: { text: "第1步：先算总腿数。第2步：再算差额。", phase: "explain", standard_answer: "3" }, expectOk: false },
    { name: "讲·术语考问应命中", input: { text: "这道题属于什么问题，你知道吗？", phase: "explain", standard_answer: "3" }, expectOk: false },
    { name: "讲·抢报答案应命中", input: { text: "所以兔子就是3只啦。", phase: "explain", standard_answer: "3", prev_student: "我不知道" }, expectOk: false },
    { name: "讲·学生已说出得数则不算泄底", input: { text: "对，兔子是3只，你真棒。", phase: "explain", standard_answer: "3", prev_student: "我算出来兔子有3只" }, expectOk: true },
    { name: "练·题干点明运算应命中", input: { text: "把两个速度相加，一共走多远？", phase: "practice", standard_answer: "60" }, expectOk: false },
    { name: "诊断·干净应通过", input: { text: "你第3步卡住了，差额那里方向反了，再想想。", phase: "diagnose", standard_answer: "4" }, expectOk: true },
    { name: "诊断·含算式应命中", input: { text: "第3步应该是8÷2=4。", phase: "diagnose", standard_answer: "4" }, expectOk: false },
    { name: "干预·结尾踢球应通过", input: { text: "差额已经找到了，你想想这个差额该除以几呢？", phase: "intervene", standard_answer: "4" }, expectOk: true },
    { name: "干预·结尾不踢球应命中", input: { text: "差额除以每只兔多的腿数就得到兔子数。就是这样。", phase: "intervene", standard_answer: "4" }, expectOk: false },

    // ---- 回归：standard_answer 存的是「整段解题过程」时，不能因复述题干/步号而误报 ----
    { name: "讲·复述题干给定条件不算泄底(final_answer)", input: { text: "第1步：笼子里有10个头，一共26条腿，每只鸡2条腿。引导：哪个数是头，哪个是腿？", phase: "explain", final_answer: "3", problem_text: "头10脚26，每只鸡2条腿每只兔4条腿" }, expectOk: true },
    { name: "讲·problem_text 里的给定条件从泄底名单减掉", input: { text: "第1步：题目说一共10个头。引导：这10个数是什么？", phase: "explain", final_answer: "3", problem_text: "头10脚26" }, expectOk: true },
    { name: "讲·步号数字不算得数(扫描前剥离第N步)", input: { text: "第4步：我们来算兔子的只数。引导：差额里藏着几只兔呢？", phase: "explain", final_answer: "4" }, expectOk: true },
    // 已知局限：只传 standard_answer(整段过程)时，中间数字(如 6÷2=3 里的 2)无法与得数区分，可能误报。
    // 这是为什么 SKILL.md 要求调用方优先传 final_answer。此用例把该局限钉成契约，防止误以为回退路径完美。
    { name: "讲·standard_answer 回退路径会把过程中间数字误当得数(已知局限)", input: { text: "第2步：假设全是鸡，每只鸡2条腿。引导：一共几条腿？", phase: "explain", standard_answer: "兔=3；假设全鸡20腿，差6，6÷2=3", problem_text: "头10脚26" }, expectOk: false },
    { name: "讲·真得数即使夹在过程里也应命中", input: { text: "所以兔子就是3只啦，很简单吧。", phase: "explain", final_answer: "3", prev_student: "还没想好" }, expectOk: false },
    { name: "讲·final_answer优先于standard_answer", input: { text: "第2步：假设全是鸡，每只鸡2条腿。引导：一共几条腿？", phase: "explain", final_answer: "3", standard_answer: "3只兔7只鸡，2条腿4条腿", problem_text: "头10脚26" }, expectOk: true },

    // ---- 回归：算式检测必须覆盖全宽/排印运算符变体 ----
    // 中文教学文本里 LLM 常写「60−40」(U+2212)、「60－40」(全宽) 而非 ASCII「60-40」。
    // 只认 ASCII 会让这些含算式的讲解全部漏检（写追及问题骨架时真的漏了一条）。
    { name: "讲·真减号U+2212算式应命中", input: { text: "第4步：每分钟追近 60−40。\n引导：那要多久追上？", phase: "explain", final_answer: "10分钟", problem_text: "甲40乙60" }, expectOk: false },
    { name: "讲·全宽减号算式应命中", input: { text: "第4步：每分钟追近 60－40 米。", phase: "explain", final_answer: "10分钟", problem_text: "甲40乙60" }, expectOk: false },
    { name: "讲·全宽加号算式应命中", input: { text: "第3步：速度和是 40＋50。", phase: "explain", final_answer: "10分钟", problem_text: "甲40乙50" }, expectOk: false },
    { name: "讲·全宽除号算式应命中", input: { text: "第5步：200／20 就是答案。", phase: "explain", final_answer: "10分钟", problem_text: "相距200" }, expectOk: false },
    { name: "练·真减号算式题干应命中", input: { text: "每分钟追近 60−40 米，那追上要几分钟？", phase: "practice", final_answer: "10分钟", problem_text: "甲40乙60" }, expectOk: false },
    // 误报防线：纯文字引导不含数字算式，必须放行
    { name: "讲·纯文字引导不误报", input: { text: "第3步：该把两人的速度加起来，还是减掉呢？\n引导：为什么？", phase: "explain", final_answer: "10分钟", problem_text: "甲40乙60" }, expectOk: true },
    { name: "讲·复述题干两个数字不构成算式", input: { text: "第2步：甲在乙前面200米，乙每分钟60米。\n引导：乙每分钟能追近多少？", phase: "explain", final_answer: "10分钟", problem_text: "甲在乙前面200米，乙每分钟60米，甲每分钟40米" }, expectOk: true },

    // ---- 中间量保护：泄露"还没轮到的过程值"和泄露得数一样致命 ----
    // 实测四个题型（追及/和差倍/归一/按比例分配）都能这样绕过 final_answer 保护。
    { name: "讲·泄露追及距离(中间量)应命中", input: { text: "第2步：哥哥领先的距离是180米。\n引导：那弟弟每分钟追近多少？", phase: "explain", final_answer: "9分钟", problem_text: "哥哥45米每分先走4分钟，弟弟65米每分", steps_solution: "1同向;2追及距离=45×4=180米;3速度差;4=65-45=20;5=180÷20=9分钟", current_step: 2 }, expectOk: false },
    { name: "讲·泄露'减掉差之后的和'应命中", input: { text: "第4步：把和减掉差之后是36。\n引导：这36代表什么？", phase: "explain", final_answer: "大数34小数18", problem_text: "两数和52，差16", steps_solution: "1和与差;2小数作基准;3大数=小数+16;4(52-16)=36,36÷2=18", current_step: 4 }, expectOk: false },
    { name: "讲·泄露单价(归一中间量)应命中", input: { text: "第3步：一支笔其实是3元。\n引导：那8支呢？", phase: "explain", final_answer: "24元", problem_text: "5支笔15元，8支要多少元", steps_solution: "1单价不变;2先求一份;3=15÷5=3元;4=3×8=24元", current_step: 3 }, expectOk: false },
    { name: "讲·泄露总份数应命中", input: { text: "第2步：一共是5份。\n引导：那一份多少钱？", phase: "explain", final_answer: "甲20元乙30元", problem_text: "50元按2:3分给甲乙", steps_solution: "1总量50比2:3;2总份数=2+3=5;3=50÷5=10元;4甲=10×2=20,乙=10×3=30", current_step: 2 }, expectOk: false },
    { name: "干预·泄露中间量应命中", input: { text: "第2步应该先算领先的距离，也就是180米。\n你再想想接下来怎么办？", phase: "intervene", final_answer: "9分钟", problem_text: "哥哥45米每分先走4分钟", steps_solution: "2追及距离=45×4=180米;4=20;5=9分钟", current_step: 2 }, expectOk: false },
    // 误报防线 1：已经讲过的步骤不再保护 —— 学生自己算出过的值，老师复述是正当引导。
    // 这条是本设计误报概率低的主要来源（当前步之后才保护）。
    { name: "讲·复述已讲过步骤的中间量不误报", input: { text: "第4步：你刚算出每份是10元。\n引导：那甲有多少钱？", phase: "explain", final_answer: "甲20元乙30元", problem_text: "50元按2:3分给甲乙", steps_solution: "2总份数=5;3=50÷5=10元;4甲=10×2=20", current_step: 4 }, expectOk: true },
    // 误报防线 2：学生自己已说出的数字不算老师泄露
    { name: "讲·学生已说出中间量则不算泄露", input: { text: "对，一份就是10元。\n引导：那甲呢？", phase: "explain", final_answer: "甲20元乙30元", problem_text: "50元按2:3分", steps_solution: "3=50÷5=10元;4甲=20", current_step: 3, prev_student: "50除以5，一份10元" }, expectOk: true },
    // 误报防线 3：题干给定条件永远可复述
    { name: "讲·复述题干条件不算泄露中间量", input: { text: "第2步：题目说哥哥每分钟45米，先走了4分钟。\n引导：那他领先多远？", phase: "explain", final_answer: "9分钟", problem_text: "哥哥每分钟45米先走4分钟，弟弟每分钟65米", steps_solution: "2追及距离=45×4=180米", current_step: 2 }, expectOk: true },
    { name: "讲·没传 steps_solution 时不改变原有行为", input: { text: "第2步：题目说共10个头。\n引导：这是什么意思？", phase: "explain", final_answer: "3", problem_text: "头10脚26" }, expectOk: true },
    { name: "讲·纯引导问句不误报", input: { text: "第2步：弟弟出发时哥哥已经在前面了。\n引导：哥哥那4分钟走了多远？", phase: "explain", final_answer: "9分钟", problem_text: "哥哥每分钟45米先走4分钟", steps_solution: "2追及距离=45×4=180米;5=9分钟", current_step: 2 }, expectOk: true },

    // ---- 回归：分数不是算式 ----
    // `2/5` 在中文数学语境几乎总是分数而非"2除以5"。一律当算式会让分数题型
    // 连复述题干都过不去（分数应用题实测整个骨架不可用）。这是斜杠一直在运算符
    // 字符类里的老问题，此前没暴露只因库里没有分数题型。
    { name: "讲·裸分数复述题干应放行", input: { text: "第1步：题目说看了全书的2/5，还剩下72页。\n引导：这个2/5是谁的2/5？", phase: "explain", final_answer: "120页", problem_text: "看了全书的2/5，还剩72页，全书多少页" }, expectOk: true },
    { name: "讲·工程问题的效率分数应放行", input: { text: "第2步：把这项工程看作一个整体。\n引导：甲一天能完成其中的几分之几？", phase: "explain", final_answer: "4天", problem_text: "甲6天完成，乙12天完成" }, expectOk: true },
    { name: "讲·分数参与乘法应命中", input: { text: "第4步：所以要算 60×3/4。\n引导：试试？", phase: "explain", final_answer: "45棵", problem_text: "桃树60棵，梨树是桃树的3/4" }, expectOk: false },
    { name: "讲·分数参与减法应命中", input: { text: "第3步：剩下的就是 1-2/5。\n引导：那是多少？", phase: "explain", final_answer: "120页", problem_text: "看了全书的2/5" }, expectOk: false },

    // ---- 阶段放行：summarize/review 不审计，应直接 ok ----
    { name: "总结·不审计应放行", input: { text: "第1步先算总腿数，第2步算差额 6÷2=3。", phase: "summarize", standard_answer: "3" }, expectOk: true },
    { name: "复盘·不审计应放行", input: { text: "这道题的答案是兔3鸡7。", phase: "review", final_answer: "3" }, expectOk: true },
    { name: "未知阶段应命中", input: { text: "随便", phase: "foobar" }, expectOk: false },
  ];
  let pass = 0;
  for (const c of cases) {
    const r = guard(c.input);
    const ok = r.ok === c.expectOk;
    if (ok) pass++;
    console.log(`${ok ? "✅" : "❌"} ${c.name}${ok ? "" : `  → 期望 ok=${c.expectOk}，实际 ok=${r.ok}，命中：${JSON.stringify(r.violations)}`}`);
  }
  console.log(`\n${pass}/${cases.length} 通过`);
  process.exit(pass === cases.length ? 0 : 1);
}

// ---- CLI ----
//
// 为什么加 flag 接口：教学文本几乎必然含换行（"第N步 / 引导"两段式），
// 用 `echo '{...}' | node guard.mjs` 传 JSON 时，单引号里的字面换行会让 JSON 非法，
// 守卫报 `{"ok":false,"violations":[{"rule":"输入不是合法 JSON"}]}` —— 看起来像命中红线，
// 实则是调用姿势错了，极易被误读成"这段话泄底了"。
// 所以把待发文本改从文件读（--text-file），其余参数走 flag，彻底绕开转义。
// stdin JSON 仍然支持，作为向后兼容路径。

const HELP = `AI Teaching Engine · 运行时守卫

推荐用法（把待发给学生的文本写进文件，无需任何转义）：
  node guard.mjs --text-file <path> --phase <explain|practice|diagnose|intervene> \\
                 --final-answer "<纯得数>" --problem-text "<题干原文>" \\
                 [--prev-student "<上轮学生发言>"] [--round <N>]

也可以直接传文本（仅适合单行）：
  node guard.mjs --text "第2步：…" --phase explain --final-answer 3

向后兼容（stdin 传 JSON，换行需转义成 \\n）：
  node guard.mjs < payload.json

输出：{"ok":true,"violations":[],"audited":true}
     {"ok":false,"violations":[{"rule","evidence"}],"audited":true}
     audited:false 表示该阶段本就不校验（summarize / review）
退出码：0 = ok，1 = 命中红线，2 = 用法/输入错误`;

function parseArgs(argv) {
  const out = {};
  const alias = {
    "--text": "text", "--phase": "phase", "--final-answer": "final_answer",
    "--standard-answer": "standard_answer", "--problem-text": "problem_text",
    "--prev-student": "prev_student", "--round": "round", "--text-file": "textFile",
    "--steps-solution": "steps_solution", "--current-step": "current_step",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = alias[argv[i]];
    if (!key) continue;
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      return { error: `${argv[i]} 缺少取值` };
    }
    out[key] = val;
    i++;
  }
  return out;
}

function emit(result) {
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

function fail(rule, evidence = "") {
  console.log(JSON.stringify({ ok: false, violations: [{ rule, evidence }], audited: false }));
  process.exit(2);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);

  if (argv.includes("--selftest")) {
    selftest();
  } else if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
  } else if (argv.some((a) => a.startsWith("--"))) {
    // flag 模式
    const args = parseArgs(argv);
    if (args.error) fail("用法错误", args.error);
    if (args.textFile) {
      if (args.text !== undefined) fail("用法错误", "--text 与 --text-file 只能给一个");
      try { args.text = fs.readFileSync(args.textFile, "utf8"); }
      catch (e) { fail("读不到 --text-file", e.message); }
    }
    if (args.text === undefined) fail("用法错误", "必须给 --text 或 --text-file（看 --help）");
    if (!args.phase) fail("用法错误", "必须给 --phase（explain|practice|diagnose|intervene）");
    delete args.textFile;
    if (args.round !== undefined) args.round = Number(args.round) || 0;
    if (args.current_step !== undefined) args.current_step = Number(args.current_step) || 0;
    emit(guard(args));
  } else {
    // stdin JSON（向后兼容）
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); }
      catch {
        fail("输入不是合法 JSON", `${raw.slice(0, 80)}  ← 教学文本含换行时 JSON 易非法，改用 --text-file（node guard.mjs --help）`);
      }
      emit(guard(payload));
    });
  }
}
