---
name: ai-teaching-engine
description: Use when user wants an AI tutor to teach them a math/science problem step-by-step through a 讲→练→诊断→干预→复盘 five-step loop, needs interactive problem diagnosis with stuck-type classification, or asks for "Socratic tutoring" that stops halfway to let them think. Triggers on "教我这道题", "AI辅导", "讲练诊断", "五步教学", "分步讲解", "diagnose my answer", "教我这题".
---

# AI Teaching Engine — State Machine Skill

## Overview

Two-mode LLM:
- **Default**: you ARE the teacher
- **Override**: `~/.ai-teaching-config.json` → call configured API

State in `~/.ai-teaching-state.json`.

## 家长首次配置

给孩子用之前，家长在终端跑一次：

```bash
cd <此技能目录>
node setup.mjs
```

它会检查环境、跑安全网自测、清掉上次遗留的学习状态（备份为 `.bak`），并打印孩子怎么开始。
**默认模式（Mode A）无需任何 API Key** —— 装了本技能的 AI 助手自己就是老师。
想用自己的 API（Mode B）：在 `~/.ai-teaching-config.json` 配置后重跑 `setup.mjs`。

孩子开始：对 AI 助手说「教我这道题：<题目>」或发题目照片。
教学面板实时写到 `~/Downloads/ai-teaching-card.html`，家长用浏览器打开即可看到孩子学到哪、卡在哪。

## Architecture

```
host agent
    │ SETUP → 分类 → 骨架
    │ TEACH LOOP
    ├─ 按 prompts.js 生成内容
    ├─ 构造 HTML（含 inline SVG 配图）
    ├─ 写 ~/Downloads/ai-teaching-card.html （auto-refresh）
    ├─ chat 对话引导/互动
    └─ 更新 state
    │ PRACTICE
    ├─ 练习表单追加到同一个 ai-teaching-card.html 底部
    └─ 学生填完提交 → 收集答案进 DIAGNOSE
```

**所有阶段共用一个文件**：`~/Downloads/ai-teaching-card.html`。讲解消息、练习表单、诊断结果都追加到同一个页面。

## State Machine

```
SETUP → EXPLAIN → SUMMARIZE → PRACTICE → DIAGNOSE ──correct──→ REVIEW
                                    ↑         ↓                  ↑
                                    │    INTERVENE ──passed──→   │
                                    │         ↓                  │
                                    └──retry──┘ (inner loop ≤2)  │
                                                               escape←┘
```

State file `~/.ai-teaching-state.json`:
```json
{
  "phase": "...",
  "problem": {"text":"...", "topic":"...", "final_answer":"纯得数", "steps_solution":"分步过程", "grade":"..."},
  "skeleton": {"type":"...", "steps":[...]},
  "turns": [],
  "explain": {"step":1, "history":[]},
  "practice": {},
  "diagnosis": {},
  "intervene": {"stuck_type":"", "stuck_step":0, "count":0, "question":""},
  "inner_loop": 0,
  "via_escape": false
}
```

## HTML 卡片（时序面板）

`~/Downloads/ai-teaching-card.html` 显示全部教学历史，auto-refresh 2s。

### 结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{topic} · AI 教学面板</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#f5f6f8;color:#1f2329}
.msg{padding:10px 14px;margin:8px 0;border-radius:10px;line-height:1.7;white-space:pre-wrap}
.msg.teacher{background:#fff;border:1px solid #e5e6eb}
.msg.student{background:#3370ff;color:#fff;margin-left:60px}
.msg.note{background:transparent;color:#8f959e;font-size:13px;text-align:center;border:1px dashed #d0d5dd;margin:4px 60px}
.card{background:#fff;border:1px solid #e5e6eb;border-radius:10px;padding:12px 16px;margin:8px 0;white-space:pre-wrap}
svg{display:block;margin:8px auto;max-width:100%}
.steps{background:#f0f4ff;border-radius:8px;padding:8px 14px;margin:4px 0}
.steps li{margin:4px 0}
.tag{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}
.tag-explain{background:#eaf1ff;color:#3370ff}
.tag-practice{background:#fff3e0;color:#e67e22}
.tag-diagnose{background:#fce4ec;color:#e53935}
.tag-review{background:#e8f5e9;color:#43a047}
.highlight{background:#fff9e6;padding:0 4px;border-radius:4px}
.progress{height:3px;background:#e5e6eb;border-radius:2px;margin-bottom:12px}
.progress-fill{height:100%;background:#3370ff;border-radius:2px;transition:width .4s}
</style></head>
<body>
<div class="progress"><div class="progress-fill" style="width:{progress}%"></div></div>
{turns_html}
</body></html>
```

### 每轮 turns_html 生成

维护 `state.turns` 数组，每轮追加一条 turn，然后重写完整 HTML。

**EXPLAIN turn**：
```html
<div class="msg teacher">
<div class="tag tag-explain">📖 讲·第N步</div>
<svg width="360" height="120" viewBox="0 0 360 120">
  <!-- 配图：SVG 根据上下文画示意图 -->
</svg>
{body}
</div>
```

**SVG 配图设计原则**：
- 画在卡片中的 svg 放在讲解文字上方
- 只画与当前步骤相关的视觉辅助，不画装饰
- 宽 360~400，高 80~150
- 用 `text-anchor="middle"` 等 SVG 基础标签

鸡兔同笼常用 SVG 示意：
```
10个头排成两行
🐔🐔🐔🐔🐔
🐔🐔🐔🐔🐔   10只动物，每只2条腿 → 20条腿
↓ 但实际有26条
🐰🐰🐰       这3只其实是兔子，多出6条腿
```

可用圆形、矩形和数字示意，不需要真的画动物表情。

**学生 turn**：
```html
<div class="msg student">{body}</div>
```

**SUMMARIZE turn**：
```html
<div class="card">
<div class="tag tag-explain">🧭 解题步骤</div>
<ol class="steps">
<li>第1步：...</li>
<li>第2步：...</li>
</ol>
</div>
```

**DIAGNOSE turn**：
```html
<div class="card">
<div class="tag tag-diagnose">🎯 诊断</div>
{结果描述}
</div>
```

**REVIEW turn**：
```html
<div class="card">
<div class="tag tag-review">🎯 复盘</div>
<strong>一句话总结</strong><br>{summary}<br>
<strong>下次怎么想</strong><br>{next_time}<br>
{encourage}
</div>
```

**注意**：每轮追加 turn 后**完整重写**全部 turns 的 HTML，不是只写当前轮。学生看到的始终是完整历史。

## HTML 练习表单（PRACTICE）

`~/Downloads/ai-teaching-practice.html`，一次性展示全部分步题。

模板（step 按 practice JSON 的 steps 数组逐个生成）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<title>练一练 · {topic}</title>
<style>
body{font-family:-apple-system,...;max-width:600px;margin:24px auto;padding:0 16px;background:#f8f9fa}
.step{border:1px solid #d0d5dd;border-radius:10px;padding:14px;margin:12px 0;background:#fff}
.step legend{font-weight:600;color:#3370ff}
input[type="radio"]{accent-color:#3370ff}
.fill-input{width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px;font-size:15px;box-sizing:border-box}
button{background:#3370ff;color:#fff;padding:12px 28px;border:none;border-radius:8px;font-size:16px;cursor:pointer}
button:hover{background:#2952cc}
#result{display:none;background:#1e1e2e;color:#cdd6f4;padding:14px;border-radius:8px;font-family:monospace;white-space:pre-wrap}
</style></head>
<body>
<h2>📝 练一练 · {topic}</h2>
<p class="story">{story}</p>
<form id="practice">
{steps}
</form>
<button onclick="submitAnswers()">📤 提交</button><pre id="result"></pre>
<script>
function submitAnswers(){
  const data=new FormData(document.getElementById('practice'));
  const answers={}; for(let[k,v]of data)answers[k.replace('q','')]=v;
  const j=JSON.stringify({practice:true,answers},null,2);
  document.getElementById('result').textContent=j;document.getElementById('result').style.display='block';
  if(navigator.clipboard)navigator.clipboard.writeText(j);
}
</script>
</body></html>
```

每步生成规则：
- choice 类型 → `<fieldset class="step"><legend>第{id}步</legend><p>{q}</p><ul class="options">{options}</ul></fieldset>`
- fill 类型 → `<fieldset class="step"><legend>第{id}步</legend><p>{q}</p><input class="fill-input" type="text" name="q{id}" placeholder="输入你的答案" required></fieldset>`

**fill 步题干红线**（继承 prompts.js 出题红线）：
- ❌ 不能出现该步的算式/公式（如"多出的腿数 ÷ 每只兔少算的腿数 = ?"）
- ❌ 不能暗示用什么运算（如"想一想，多出来的腿数怎么变成兔子的只数"）
- ✅ 只问结果："兔子有几只？"、"鸡有几只？"
- choice 步选项也不能把正确答案写得太明显（如选项"差额8条，每只兔少算2条"同时给了数值和原因→太简单）

## How to Generate Content

- **Mode A (default)**: You ARE the LLM. Read templates in `prompts.js`.
- **Mode B**: `bash curl` to configured API.

## Phase-by-Phase

### PHASE 0: SETUP

1. "你想学哪道题？" Image → `analyze-material`. Grade 默认小学高年级.
2. Classify → load/generate skeleton. New → confirm.
3. 解出答案，**拆成两份存**：`final_answer`（纯得数，供守卫判泄底）与 `steps_solution`（分步过程，供诊断对照）。Write state. Show plan → EXPLAIN.

第一轮 HTML 卡片告知学生："打开 ~/Downloads/ai-teaching-card.html 即可实时查看教学面板。"

### PHASE 1: EXPLAIN

One step per turn. Follow 讲模板 in prompts.js.

**引导约束**：
- ❌ "6÷2=？兔子有几只？" — 直接给了算式
- ✅ "每只兔少算2条腿，一共多出6条，那有几只兔？" — 让学生自己决定运算

每轮：生成内容 → 追加 turn → 写 HTML → chat 引导。

**SVG 配图建议**（鸡兔同笼）：
- 第1步：两行圆点（10个），标注头数和腿数
- 第2步：10个圆点，每点下画2竖线（假设全鸡，20腿）
- 第3步：10个圆点中3个改画4竖线（揭示差额来源）
- 第4步：标出3个兔子，写"6÷2=3"
- 其他题型自行设计合适图示

### PHASE 2: SUMMARIZE

生成 `{title, steps}` → 追加 steps turn → 写 HTML → PRACTICE.

### PHASE 3: PRACTICE

生成 `{story, steps, answer}`。

**不另建文件**——在 `ai-teaching-card.html` 底部追加练习表单（含 `<form>` + radio/text inputs + submit button + clipboard JS）。之前的讲解消息保留不动，表单追加在它们下方。

学生填完点提交 → JSON 自动复制到剪贴板 → 粘贴到 chat → agent 提取 answers → 进入 DIAGNOSE。

收到答案后，把表单替换为学生的作答（消息气泡形式），保留在历史中。

### PHASE 4: DIAGNOSE

生成 `{correct, step, type, ...}` → 追加诊断 turn → 写 HTML.
correct→REVIEW | 低置信→核实 | 其他→INTERVENE.

**诊断红线**：DIAGNOSE 只说"第几步错、错在哪里"，不出正确算式/答案。

### PHASE 5: INTERVENE

生成引导 → 追加 turn → 写 HTML → 追问 → 判定 `{passed, reply}`.

**干预红线（不得违反）**：
- DIAGNOSE 诊断阶段只指出"第几步错了、错在哪里"，**不能给出正确算式/答案**
- INTERVENE 引导可以指出"方向和依据"，**不能直接把正确算式和结果给学生**
- ❌ "应该是差额8÷2=4"
- ❌ "每只兔少算2条，所以8÷2=4只"
- ✅ "第3步已经找到差额了，你想想这个差额应该除以几？"
- ✅ "兔子比鸡多几条腿？那每条兔要多补2条腿，差额里面有几个2？"

**干预通过后的流转（不得跳过）**：
- passed=true → inner_loop++ → **生成一道全新的变式题** → 回到 PRACTICE
- **不是继续把当前题做完**，而是出新题让学生独立走5步
- inner_loop > 2 → escape to REVIEW
- passed=false → 重问（同一卡点最多3次）→ 仍不过 → escape to REVIEW

### PHASE 6: REVIEW

生成 `{summary, next_time, encourage}` → 追加复盘 turn → 写 HTML → done.

## Escape Hatches

- "给我答案" → REVIEW
- Inner loop > 2 / same intervene ≥ 3 → REVIEW

## Files

| File | Purpose |
|------|---------|
| `prompts.js` | 各 phase 行为模板 |
| `problem-types/` | 题型骨架库 |
| `guard.mjs` | 运行时守卫：回复前校验教学红线（见下） |
| `setup.mjs` | 家长首次配置：环境检查 / 清理旧状态 / 安全网自测 |

## 运行时守卫（安全网 · 不得跳过）

散文规则（不泄露答案、一次一步、不考术语、诊断/干预不给算式）光靠自觉不够。
**每一轮、在把内容发给学生之前，必须先过 `guard.mjs` 校验**。这是保护孩子的硬性关卡。

### 什么时候过

只对**发给学生看的教学文本**校验：EXPLAIN / PRACTICE 出题题干 / DIAGNOSE / INTERVENE 四个阶段。
SUMMARIZE、REVIEW、纯 state 写入不需要过。

### 怎么调

```bash
echo '{"text":"<即将发给学生的文本>","phase":"explain","final_answer":"<最终得数>","problem_text":"<题干原文>","prev_student":"<上一轮学生发言>","round":<该阶段第几轮>}' | node guard.mjs
```

- `phase`：`explain` | `practice` | `diagnose` | `intervene`（`summarize` / `review` 传进去会直接放行、返回 `audited:false`，无需特意避开）
- `final_answer`：**强烈建议传**，只放**最终得数**（如 `"兔3只鸡7只"` 或 `"5分钟"`）。守卫靠它判断你有没有抢先报出答案。
  - EXPLAIN 阶段取 `state.problem.final_answer`；PRACTICE 之后各阶段（诊断/干预）取本次练习题的 `practice.final_answer`。
  - **务必是纯得数**——不要把 `steps_solution` 里的过程/中间值塞进来，否则守卫会把中间数字误当得数而误报。
- `problem_text`：题干原文（EXPLAIN 用 `state.problem.text`，PRACTICE 后用 `practice.story`）。里面的数字是**给定条件**，老师本就能复述——守卫会把这些数字从泄底名单里减掉，避免"复述已知条件"被误判成泄底。
- `standard_answer`：**已弃用的向后兼容**字段。没传 `final_answer` 时才退回用它抽数字，但它若是整段解题过程，**中间数字（如 `6÷2=3` 里的 `2`）无法与得数区分，可能误报**。新代码一律传 `final_answer`，不要再依赖它。
- `prev_student`：上一轮学生发言。若学生自己已说出某数值，守卫不再把它算作泄底。
- 「第N步」这类步号数字会在扫描前自动剥离，不会被当成得数。
- 返回 `{"ok":true,"violations":[],"audited":true}` 或 `{"ok":false,"violations":[{"rule","evidence"}],"audited":true}`；`audited:false` 表示该阶段本就不校验（已放行）。

### 命中后怎么办（重生成，不是放行）

```
生成内容 → 过 guard
  ├─ ok=true  → 写 HTML → 回复学生
  └─ ok=false → 读 violations，针对命中的红线重写这段内容 → 再过 guard
                （最多重试 2 次；仍不过则退回"只给一句纯引导问句、绝不含算式/得数"的安全兜底，
                  再过一次 guard 确认 ok=true 才发出）
```

**绝不允许**把 `ok=false` 的文本发给学生或写进 HTML。宁可这一轮只问一句、也不泄底。

### 自测

改动 `guard.mjs` 或 `prompts.js` 后跑 `node guard.mjs --selftest`，确认全部通过再交给孩子用。

## Key Rules

**已知限制**：
- 目前仅支持**纯文字题**（鸡兔同笼、相遇问题、工程问题、按比例分配等）
- 学生上传截图时，`analyze-material` 提取文字后当纯文字题处理
- **不支持**需要看图才能理解的题（几何图形、图表数据、空间推理）
- SVG 配图画的是教学示意（如圆点代表头数），不还原原题图片
- 未来计划：嵌入原图 + 几何题型骨架

1. State in `~/.ai-teaching-state.json` — **阶段切换时统一更新**（不是每轮对话都写）：
   - SETUP 完成 → 存 problem/skeleton/phase
   - EXPLAIN 完成 → 存 explain.history/phase
   - PRACTICE 收完答案 → 存 practice.answers/phase
   - DIAGNOSE 完成 → 存 diagnosis/phase
   - INTERVENE 完成 → 存 intervene 结果/route
   - REVIEW 完成 → 存最终总结/phase=done
   - 共 ~6 次更新，在自然断点执行
2. Skeleton is single source of truth
3. EXPLAIN 引导不给算式
4. One step per turn, never leak answer —— 由「运行时守卫」强制校验，不只靠自觉
5. Don't quiz on terminology
6. **每轮顺序**：生成内容 →（教学文本先过 `guard.mjs`，命中则重生成）→ 写 HTML → 再回复 chat。守卫和 HTML 都是每轮必做动作，不做完不许回复（防止遗忘、防止泄底）
7. **所有阶段用一个 HTML 文件**（`ai-teaching-card.html`），练习表单追加到同一页面底部
8. **智能刷新 + 表单保护**（不用 `<meta refresh>`）：
   - 用 JS 定时刷新，但**输入框聚焦时跳过**：`if(document.activeElement.tagName==='INPUT')return; location.reload();`
   - 表单用 `window.name` + 唯一 `FORM_ID` 持久化（防旧题污染新题）
   - 讲解/诊断阶段：无输入聚焦 → 自动刷新
   - 练习阶段：学生正在打字 → 不刷新 → 不打断
9. **禁止压缩旧内容**——每条 turn 原样保留，不得概括成一行
9. SVG 只画跟当前步骤相关的图示，不装饰
10. Short, conversational, encouraging
