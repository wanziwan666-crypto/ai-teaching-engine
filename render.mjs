// Math Tutor · 教学面板渲染器（确定性 HTML 输出）
//
// 为什么存在：面板过去靠 LLM 每轮照着 SKILL.md 里的模板手抄一整页 HTML，
// 而且要求"完整重写全部历史 turn、不许压缩旧内容"——抄写量大、极易漂移。
// 用规则去堵一个确定性问题是错的。这里把渲染变成纯函数：
//   state.turns（结构化数据）→ 完整 HTML
// LLM 只负责往 state.turns 追加一条结构化 turn，页面长什么样由本文件唯一决定。
// 历史不可能被压缩，因为没人再"重写"它。
//
// 用法：
//   node render.mjs                          # ~/.math-tutor-state.json → ~/Downloads/math-tutor-card.html
//   node render.mjs --stdout                 # 打到标准输出，不落盘
//   node render.mjs --state s.json --out c.html
//   node render.mjs --selftest
//
// turn 结构（state.turns 数组，每条一个对象；phase 决定怎么渲染）：
//   {role:"teacher", phase:"explain", step:2, body:"…", svg:"<svg…>"}
//   {role:"student", body:"…"}
//   {role:"note",    body:"…"}
//   {phase:"summarize", title:"…", steps:["第1步：…","第2步：…"]}
//   {phase:"practice",  story:"…", form_id:"p1", steps:[{id,type,q,options}], answers:{"1":"…"}}
//   {phase:"diagnose",  body:"…"}
//   {phase:"intervene", body:"…"}
//   {phase:"review",    summary:"…", next_time:"…", encourage:"…"}
//
// practice turn 有 answers 字段 → 渲染成"已提交"回顾；没有 → 渲染成可填写的表单。
// 同一条 turn 从表单变成回顾，靠的是追加 answers，不是新增 turn。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const STATE_PATH = path.join(HOME, ".math-tutor-state.json");
export const CARD_PATH = path.join(HOME, "Downloads", "math-tutor-card.html");

// body 一律转义后靠 CSS 的 white-space:pre-wrap 保留换行。
// 教学文本是 LLM 生成的纯文本，不该当 HTML 解析——否则一个 "<" 就能弄坏整页。
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// SVG 是唯一按原样嵌入的内容（配图必须能画）。做最小把关：
// 必须是 <svg> 开头，且不含脚本/事件属性；不合格就整段丢掉而不是硬塞进页面。
const SVG_UNSAFE = /<\s*script|javascript:|\son\w+\s*=/i;
export function safeSvg(svg) {
  const s = String(svg ?? "").trim();
  if (!s || !/^<svg[\s>]/i.test(s) || SVG_UNSAFE.test(s)) return "";
  return s;
}

// ---- 页面外壳 ----

const STYLE = `
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#f5f6f8;color:#1f2329}
.msg{padding:10px 14px;margin:8px 0;border-radius:10px;line-height:1.7;white-space:pre-wrap}
.msg.teacher{background:#fff;border:1px solid #e5e6eb}
.msg.student{background:#3370ff;color:#fff;margin-left:60px}
.msg.note{background:transparent;color:#8f959e;font-size:13px;text-align:center;border:1px dashed #d0d5dd;margin:4px 60px}
.card{background:#fff;border:1px solid #e5e6eb;border-radius:10px;padding:12px 16px;margin:8px 0;white-space:pre-wrap}
svg{display:block;margin:8px auto;max-width:100%}
.steps{background:#f0f4ff;border-radius:8px;padding:8px 14px;margin:4px 0}
.steps li{margin:4px 0}
.tag{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;margin-bottom:6px}
.tag-explain{background:#eaf1ff;color:#3370ff}
.tag-practice{background:#fff3e0;color:#e67e22}
.tag-diagnose{background:#fce4ec;color:#e53935}
.tag-review{background:#e8f5e9;color:#43a047}
.highlight{background:#fff9e6;padding:0 4px;border-radius:4px}
.progress{height:3px;background:#e5e6eb;border-radius:2px;margin-bottom:12px}
.progress-fill{height:100%;background:#3370ff;border-radius:2px;transition:width .4s}
.step{border:1px solid #d0d5dd;border-radius:10px;padding:14px;margin:12px 0;background:#fff}
.step legend{font-weight:600;color:#3370ff}
.step p{margin:6px 0 10px}
.options{list-style:none;padding:0;margin:0}
.options li{margin:6px 0}
.options label{cursor:pointer}
input[type="radio"]{accent-color:#3370ff}
.fill-input{width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px;font-size:15px;box-sizing:border-box}
button{background:#3370ff;color:#fff;padding:12px 28px;border:none;border-radius:8px;font-size:16px;cursor:pointer}
button:hover{background:#2952cc}
#result{display:none;background:#1e1e2e;color:#cdd6f4;padding:14px;border-radius:8px;font-family:monospace;white-space:pre-wrap;margin-top:10px}
.answered{color:#3370ff;font-weight:600}
`.trim();

// 智能刷新：定时 reload，但学生正在打字（输入框聚焦）时跳过，免得刷掉他填的答案。
// 表单内容用 window.name 持久化，key 带 FORM_ID —— 换了新练习题就换 ID，
// 旧题的作答不会被恢复到新表单里。
const SCRIPT = `
var FORM_ID=document.body.dataset.formId||"";
function saveForm(){
  if(!FORM_ID)return;
  var f=document.getElementById("practice");if(!f)return;
  var d={};new FormData(f).forEach(function(v,k){d[k]=v});
  try{window.name=JSON.stringify({id:FORM_ID,data:d})}catch(e){}
}
function restoreForm(){
  if(!FORM_ID)return;
  var f=document.getElementById("practice");if(!f)return;
  var s;try{s=JSON.parse(window.name||"{}")}catch(e){return}
  if(!s||s.id!==FORM_ID||!s.data)return;
  Object.keys(s.data).forEach(function(k){
    var els=f.elements[k];if(!els)return;
    if(els.length&&els[0].type==="radio"){
      Array.prototype.forEach.call(els,function(el){if(el.value===s.data[k])el.checked=true});
    }else if(els.type==="radio"){ if(els.value===s.data[k])els.checked=true; }
    else{ els.value=s.data[k]; }
  });
}
function submitAnswers(){
  var f=document.getElementById("practice");if(!f)return;
  var answers={};new FormData(f).forEach(function(v,k){answers[k.replace("q","")]=v});
  var j=JSON.stringify({practice:true,answers:answers},null,2);
  var r=document.getElementById("result");
  r.textContent=j+"\\n\\n(已复制，粘贴到对话里发给老师)";r.style.display="block";
  if(navigator.clipboard)navigator.clipboard.writeText(j);
}
document.addEventListener("DOMContentLoaded",function(){
  restoreForm();
  var f=document.getElementById("practice");
  if(f){f.addEventListener("input",saveForm);f.addEventListener("change",saveForm);}
  setInterval(function(){
    var a=document.activeElement;
    if(a&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"))return;
    var r=document.getElementById("result");
    if(r&&r.style.display==="block")return;
    saveForm();location.reload();
  },2000);
});
`.trim();

// ---- 各类 turn 渲染 ----

const TAG = {
  explain: ['tag-explain', '📖 讲'],
  summarize: ['tag-explain', '🧭 解题步骤'],
  practice: ['tag-practice', '📝 练一练'],
  diagnose: ['tag-diagnose', '🎯 诊断'],
  intervene: ['tag-diagnose', '💡 引导'],
  review: ['tag-review', '🎯 复盘'],
};

function tagHtml(phase, step) {
  const [cls, label] = TAG[phase] || TAG.explain;
  const suffix = step ? `·第${step}步` : '';
  return `<div class="tag ${cls}">${esc(label)}${esc(suffix)}</div>`;
}

// 练习表单：无 answers → 可填写；有 answers → 冻结成回顾（把学生填的值显示出来）。
function renderPractice(t) {
  const formId = esc(t.form_id || 'practice');
  const steps = (t.steps || []).map((s) => {
    const legend = `<legend>第${esc(s.id)}步</legend>`;
    const q = `<p>${esc(s.q)}</p>`;
    const given = t.answers ? t.answers[String(s.id)] : undefined;

    if (t.answers) {
      // 已提交：只回显，不再给可交互控件
      const shown = given === undefined || given === '' ? '（未作答）' : given;
      return `<fieldset class="step">${legend}${q}<div class="answered">你的答案：${esc(shown)}</div></fieldset>`;
    }
    if (s.type === 'choice') {
      const opts = (s.options || [])
        .map(
          (o) =>
            `<li><label><input type="radio" name="q${esc(s.id)}" value="${esc(o)}"> ${esc(o)}</label></li>`
        )
        .join('');
      return `<fieldset class="step">${legend}${q}<ul class="options">${opts}</ul></fieldset>`;
    }
    return `<fieldset class="step">${legend}${q}<input class="fill-input" type="text" name="q${esc(s.id)}" placeholder="输入你的答案" required></fieldset>`;
  }).join('\n');

  const head = `${tagHtml('practice')}<div class="card" style="margin-top:0">${esc(t.story)}</div>`;
  if (t.answers) return `${head}\n${steps}`;
  return `${head}\n<form id="practice" data-form-id="${formId}">\n${steps}\n</form>\n<button onclick="submitAnswers()">📤 提交</button><pre id="result"></pre>`;
}

function renderTurn(t) {
  if (!t || typeof t !== 'object') return '';

  if (t.role === 'student') return `<div class="msg student">${esc(t.body)}</div>`;
  if (t.role === 'note') return `<div class="msg note">${esc(t.body)}</div>`;

  switch (t.phase) {
    case 'summarize': {
      const items = (t.steps || []).map((s) => `<li>${esc(s)}</li>`).join('');
      return `<div class="card">${tagHtml('summarize')}${t.title ? `<strong>${esc(t.title)}</strong>` : ''}<ol class="steps">${items}</ol></div>`;
    }
    case 'practice':
      return renderPractice(t);
    case 'review':
      return `<div class="card">${tagHtml('review')}<strong>一句话总结</strong><br>${esc(t.summary)}<br><strong>下次怎么想</strong><br>${esc(t.next_time)}<br>${esc(t.encourage)}</div>`;
    case 'diagnose':
    case 'intervene':
      return `<div class="card">${tagHtml(t.phase)}${esc(t.body)}</div>`;
    default: {
      // 讲解（及未标 phase 的老师发言）：SVG 配图在讲解文字上方
      const svg = safeSvg(t.svg);
      return `<div class="msg teacher">${tagHtml(t.phase || 'explain', t.step)}${svg}${esc(t.body)}</div>`;
    }
  }
}

// 进度：按状态机阶段推进，而不是数 turn 条数（turn 数量随追问波动，不能反映进度）。
const PHASE_PROGRESS = {
  setup: 5, explain: 30, summarize: 45,
  practice: 60, diagnose: 75, intervene: 85,
  review: 95, done: 100,
};
export function progressOf(state) {
  return PHASE_PROGRESS[state?.phase] ?? 5;
}

export function renderHtml(state) {
  const s = state || {};
  const topic = s.problem?.topic || s.skeleton?.type || 'AI 教学面板';
  const turns = Array.isArray(s.turns) ? s.turns : [];
  const body = turns.map(renderTurn).filter(Boolean).join('\n');

  // 页面上最后一个未提交的练习表单决定 body 的 form-id（刷新恢复用）
  const live = [...turns].reverse().find((t) => t?.phase === 'practice' && !t.answers);
  const formId = live ? esc(live.form_id || 'practice') : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(topic)} · AI 教学面板</title>
<style>
${STYLE}
</style></head>
<body data-form-id="${formId}">
<div class="progress"><div class="progress-fill" style="width:${progressOf(s)}%"></div></div>
${body}
<script>
${SCRIPT}
</script>
</body></html>
`;
}

// 读 state → 渲染 → 写 HTML。返回写到哪、渲染了几条 turn。
export function renderToFile({ statePath = STATE_PATH, outPath = CARD_PATH } = {}) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const html = renderHtml(state);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  return { out: outPath, turns: (state.turns || []).length, phase: state.phase || "" };
}

// ---- 自测 ----

function selftest() {
  const state = {
    phase: "diagnose",
    problem: { topic: "鸡兔同笼" },
    turns: [
      { role: "teacher", phase: "explain", step: 1, body: "第1步：笼子里有10个头。\n引导：哪个数是头？", svg: '<svg width="360" height="80"><circle cx="20" cy="40" r="8"/></svg>' },
      { role: "student", body: "10是头" },
      { role: "note", body: "学生答对，推进下一步" },
      { phase: "summarize", title: "假设法三步", steps: ["第1步：读条件", "第2步：假设全是鸡"] },
      { phase: "practice", form_id: "p1", story: "头8脚22", steps: [
        { id: 1, type: "choice", q: "先算什么？", options: ["总腿数", "还没想好"] },
        { id: 2, type: "fill", q: "兔子几只？" },
      ] },
      { phase: "diagnose", body: "你第2步卡住了，差额方向反了。" },
    ],
  };

  const cases = [];
  const t = (name, cond) => cases.push({ name, cond });
  const html = renderHtml(state);

  t("含 DOCTYPE 与标题", html.startsWith("<!DOCTYPE html>") && html.includes("鸡兔同笼 · AI 教学面板"));
  t("全部 6 条 turn 都渲染（历史不被压缩）",
    html.includes("哪个数是头") && html.includes("10是头") && html.includes("推进下一步") &&
    html.includes("假设法三步") && html.includes("头8脚22") && html.includes("差额方向反了"));
  t("换行原样保留在 body 里（靠 pre-wrap）", html.includes("第1步：笼子里有10个头。\n引导："));
  t("合法 SVG 原样嵌入", html.includes('<circle cx="20" cy="40" r="8"/>'));
  t("进度按 phase 取值（diagnose=75）", html.includes("width:75%"));
  t("未提交的练习渲染成表单 + 提交按钮", html.includes('<form id="practice"') && html.includes('onclick="submitAnswers()"'));
  t("choice 出 radio，fill 出文本框", html.includes('type="radio" name="q1"') && html.includes('name="q2"') && html.includes("fill-input"));
  t("body 带 form-id 供刷新恢复", html.includes('data-form-id="p1"') && html.includes('<body data-form-id="p1"'));

  // 已提交：同一条 turn 追加 answers → 冻结成回顾
  const answered = JSON.parse(JSON.stringify(state));
  answered.turns[4].answers = { 1: "总腿数", 2: "" };
  const h2 = renderHtml(answered);
  t("已提交的练习不再渲染表单", !h2.includes('<form id="practice"') && !h2.includes('onclick="submitAnswers()"'));
  t("已提交回显学生答案", h2.includes("你的答案：总腿数"));
  t("空答案显示未作答", h2.includes("（未作答）"));
  t("已提交后 body 无 form-id", h2.includes('<body data-form-id=""'));

  // 转义与 SVG 把关
  const evil = renderHtml({ phase: "explain", turns: [
    { role: "student", body: '<script>alert(1)</script> a & b < c' },
    { role: "teacher", body: "配图应被丢掉", svg: '<svg onload="alert(1)"></svg>' },
    { role: "teacher", body: "非 svg 也丢掉", svg: '<div>x</div>' },
  ] });
  t("学生文本被转义，不产生真标签", !evil.includes("<script>alert(1)</script>") && evil.includes("&lt;script&gt;"));
  t("& 与 < 被转义", evil.includes("a &amp; b &lt; c"));
  t("带事件属性的 SVG 被丢弃", !evil.includes("onload"));
  t("非 svg 内容被丢弃", !evil.includes("<div>x</div>"));

  // 边界
  t("空 state 不崩", typeof renderHtml({}) === "string" && renderHtml({}).includes("<!DOCTYPE"));
  t("turns 非数组不崩", renderHtml({ turns: null }).includes("<!DOCTYPE"));
  t("review turn 渲染三段", renderHtml({ turns: [{ phase: "review", summary: "s", next_time: "n", encourage: "e" }] }).includes("下次怎么想"));
  t("未知 phase 落回讲解样式", renderHtml({ turns: [{ phase: "zzz", body: "x" }] }).includes('class="msg teacher"'));

  let pass = 0;
  for (const c of cases) {
    if (c.cond) pass++;
    console.log(`${c.cond ? "✅" : "❌"} ${c.name}`);
  }
  console.log(`\n${pass}/${cases.length} 通过`);
  process.exit(pass === cases.length ? 0 : 1);
}

// ---- CLI ----
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, def = "") => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const statePath = flag("--state", STATE_PATH);
    try {
      if (argv.includes("--stdout")) {
        process.stdout.write(renderHtml(JSON.parse(fs.readFileSync(statePath, "utf8"))));
      } else {
        const r = renderToFile({ statePath, outPath: flag("--out", CARD_PATH) });
        console.log(JSON.stringify({ ok: true, ...r }));
      }
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    }
  }
}
