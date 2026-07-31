// AI Teaching Engine · 运行时守卫（安全网）
//
// 用途：每一轮把「即将发给孩子的文本」在回复前过一遍这里，命中红线就重生成。
// 规则移植自 demo 的 test/selftest.mjs 审计函数，但去掉了相遇问题的硬编码，
// 改成对任意题型都成立的通用检查（靠传入的 standard_answer 判泄底，而非正则相遇/靠近）。
//
// 用法：
//   echo '{"text":"...","phase":"explain","final_answer":"3","problem_text":"头10脚26","prev_student":"..."}' | node guard.mjs
//   → stdout: {"ok":true,"violations":[]}  或  {"ok":false,"violations":[{"rule":"...","evidence":"..."}]}
//   node guard.mjs --selftest   跑内置样例
//
// 泄底检测的数字来源（务必分清三种角色，否则会大量误报）：
//   - final_answer ：最终得数，唯一「不许老师抢先说出」的数字。首选传这个。
//   - problem_text ：题干原文，里面的数字是「给定条件」，老师可自由复述 → 从泄底名单里减掉。
//   - standard_answer：向后兼容字段。若没传 final_answer，退回用它抽数字，但会减掉 problem_text
//                      里的给定条件、并剥掉「第N步」步号，尽量降噪。仍建议改传 final_answer。

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

// 含具体数字算式（如 6÷2、8*2），等于把运算方向/结果给了学生
function checkEquation(text, flag) {
  const eq = text.match(/\d+\s*[+\-×*÷/]\s*\d+/);
  if (eq) flag("出现具体数字算式，泄露了运算方向或结果", eq[0] + " ← " + matchLine(text, new RegExp(`.{0,8}${eq[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.{0,8}`)));
}

// ---- 各阶段审计 ----

// 讲：不给算式、一次一步、不考术语、不抢报答案
function auditExplain(text, ctx, flag) {
  checkNameTrap(text, flag);
  checkMultiStep(text, flag);
  checkEquation(text, flag);
  checkAnswerLeak(text, ctx, flag);
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
}

// 诊断：只说"第几步错、错在哪"，不给正确算式/答案
function auditDiagnose(text, ctx, flag) {
  checkEquation(text, flag);
  checkAnswerLeak(text, ctx, flag);
}

// 干预：可给方向和依据，但不给算式/答案；结尾要把球踢回给学生
function auditIntervene(text, ctx, flag) {
  checkEquation(text, flag);
  checkAnswerLeak(text, ctx, flag);
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
export function guard({ text = "", phase = "explain", final_answer = "", standard_answer = "", problem_text = "", prev_student = "", round = 0 } = {}) {
  const violations = [];
  const flag = (rule, evidence) => violations.push({ rule, evidence });
  // 明确不审计的阶段：直接放行，标 audited:false，方便调用方区分"过了"和"没查"。
  if (UNAUDITED.has(phase)) return { ok: true, violations: [], audited: false };
  const auditor = AUDITORS[phase];
  if (!auditor) return { ok: false, violations: [{ rule: "未知阶段", evidence: String(phase) }], audited: false };
  auditor(text, { final_answer, standard_answer, problem_text, prev_student, round }, flag);
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
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); }
      catch { console.log(JSON.stringify({ ok: false, violations: [{ rule: "输入不是合法 JSON", evidence: raw.slice(0, 80) }] })); process.exit(2); }
      console.log(JSON.stringify(guard(payload)));
    });
  }
}
