// Math Tutor · 常驻服务（daemon）
//
// 为什么存在：每轮 node turn.mjs 要冷启动 Node 进程（~100ms），
// 面板靠 2s 轮询看到更新（平均 1s 延迟）。常驻服务一次消除两个瓶颈：
//   - commit 逻辑在内存常驻的进程里跑，不启动新进程
//   - SSE 推送替代轮询，state 一变面板立刻 reload
//
// 接口与 turn.mjs 完全对齐（同样的文件参数），AI 把 `node turn.mjs` 换成 `curl` 即可：
//   curl -s "localhost:34567/turn?turn_file=/tmp/turn.json&body_file=/tmp/body.txt"
//   curl -s "localhost:34567/event?event=intervene_passed"
//   curl -s "localhost:34567/answers?answers_file=/tmp/answers.json"
//   curl -s -X POST localhost:34567/log
//
// 面板端由 render.mjs 自动处理：优先连 SSE，连不上就回退到 2s 轮询。
// daemon 不在时一切照旧，不需要改 AI 的工作流。
//
// 用法：
//   node daemon.mjs              # 前台运行，默认端口 34567
//   node daemon.mjs --port 8080  # 自定义端口
//   node daemon.mjs --selftest   # 自测
//   Ctrl+C 停止

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commit, writeLog } from "./turn.mjs";
import { renderHtml, renderToFile, STATE_PATH, CARD_PATH } from "./render.mjs";

export const DEFAULT_PORT = 34567;
const HOME = os.homedir();

// ---- SSE 客户端管理 ----

const clients = new Set();

function notifyClients(msg = "reload") {
  for (const res of clients) {
    res.write(`data: ${msg}\n\n`);
  }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, obj, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, "utf8").replace(/\n+$/, ""); }
  catch { return null; }
}

// 从 commit 结果里去掉 html 字段（太大了，HTTP 响应不需要）
function trimResult(result) {
  const { html: _h, ...rest } = result;
  return rest;
}

// ---- 路由 ----

export function createServer({ port = DEFAULT_PORT, statePath = STATE_PATH, outPath = CARD_PATH, logPath, quiet = false } = {}) {
  const log = quiet ? () => {} : (msg) => console.log(`[daemon] ${msg}`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

    // ---- GET ----

    if (req.method === "GET" && p === "/health") {
      sendJson(res, { ok: true, port, uptime: Math.round(process.uptime()), clients: clients.size });
      return;
    }

    if (req.method === "GET" && p === "/state") {
      sendJson(res, readJsonFile(statePath) || { ok: false, error: "no state" });
      return;
    }

    // SSE：面板连接后，每次 state 变化推一条 "reload"
    if (req.method === "GET" && p === "/live") {
      cors(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("data: connected\n\n");
      clients.add(res);
      log(`SSE 客户端连接（${clients.size} 活跃）`);
      req.on("close", () => {
        clients.delete(res);
        log(`SSE 客户端断开（${clients.size} 活跃）`);
      });
      return;
    }

    // ---- POST ----

    if (req.method !== "POST") {
      sendJson(res, { ok: false, error: `未知路由: ${req.method} ${p}` }, 404);
      return;
    }

    if (p === "/turn") {
      let turnObj = null;
      if (q.turn_file) {
        turnObj = readJsonFile(q.turn_file);
        if (!turnObj) { sendJson(res, { ok: false, error: `读不到 turn_file: ${q.turn_file}` }, 400); return; }
      }
      if (q.body_file && turnObj) {
        const body = readTextFile(q.body_file);
        if (body !== null) turnObj.body = body;
      }
      const result = commit({ turn: turnObj, phaseTo: q.phase_to || "", statePath, outPath });
      if (result.ok) {
        notifyClients();
        log(`POST /turn → ok (phase=${result.phase}, turns=${result.turns})`);
      } else {
        log(`POST /turn → blocked (guard violations: ${result.guard?.violations?.length || 0})`);
      }
      sendJson(res, trimResult(result));
      return;
    }

    if (p === "/event") {
      const result = commit({ event: q.event || "", statePath, outPath });
      if (result.ok) {
        notifyClients();
        log(`POST /event → ok (event=${q.event}, phase=${result.phase})`);
      }
      sendJson(res, trimResult(result));
      return;
    }

    if (p === "/answers") {
      let answers = null;
      if (q.answers_file) {
        answers = readJsonFile(q.answers_file);
        if (!answers) { sendJson(res, { ok: false, error: `读不到 answers_file: ${q.answers_file}` }, 400); return; }
      }
      const result = commit({ answers, statePath, outPath });
      if (result.ok) {
        notifyClients();
        log(`POST /answers → ok`);
      }
      sendJson(res, trimResult(result));
      return;
    }

    if (p === "/log") {
      const result = writeLog({ statePath, logPath: logPath || path.join(HOME, ".math-tutor-log.jsonl") });
      log(`POST /log → ${result.ok ? "ok" : "failed"}`);
      sendJson(res, result);
      return;
    }

    if (p === "/render") {
      const r = renderToFile({ statePath, outPath });
      notifyClients();
      log(`POST /render → ok (${r.turns} turns)`);
      sendJson(res, { ok: true, ...r });
      return;
    }

    sendJson(res, { ok: false, error: `未知路由: POST ${p}` }, 404);
  });

  server.daemonPort = port;
  return server;
}

// ---- 启动 ----

function start(port = DEFAULT_PORT) {
  const server = createServer({ port });
  server.listen(port, () => {
    const card = CARD_PATH.replace(HOME, "~");
    console.log(`[daemon] Math Tutor 服务已启动 → http://localhost:${port}`);
    console.log(`[daemon] 面板: ${card}`);
    console.log(`[daemon] 面板自动连 SSE，state 变化时实时推送 reload`);
    console.log(`[daemon] AI 调用方式：把 node turn.mjs 换成 curl localhost:${port}/turn?...`);
    console.log(`[daemon] Ctrl+C 停止`);
  });

  const shutdown = () => {
    console.log("\n[daemon] 正在关闭...");
    for (const res of clients) { try { res.end(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---- 自测 ----

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-"));
  const sp = path.join(tmp, "state.json");
  const op = path.join(tmp, "card.html");
  const lp = path.join(tmp, "log.jsonl");

  // 种子 state
  fs.writeFileSync(sp, JSON.stringify({
    phase: "explain",
    student: "test",
    problem: { topic: "测试", text: "测试题", final_answer: "42" },
    skeleton: { type: "测试", steps: [1] },
    turns: [],
    inner_loop: 0,
    intervene: { count: 0 },
  }));

  const cases = [];
  const t = (name, cond) => cases.push({ name, cond });

  // 用 port 0 让 OS 分配空闲端口
  const server = createServer({ port: 0, statePath: sp, outPath: op, logPath: lp, quiet: true });
  server.listen(0);

  server.on("listening", () => {
    const actualPort = server.address().port;
    const base = `http://localhost:${actualPort}`;
    const get = (path) => new Promise((resolve, reject) => {
      http.get(`${base}${path}`, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }).on("error", reject);
    });
    const post = (path) => new Promise((resolve, reject) => {
      const req = http.request(`${base}${path}`, { method: "POST" }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", reject);
      req.end();
    });

    (async () => {
      // health
      let r = await get("/health");
      t("health 返回 ok", JSON.parse(r.body).ok === true);

      // state
      r = await get("/state");
      t("state 返回题目", JSON.parse(r.body).problem?.topic === "测试");

      // 提交一条 turn
      const tf = path.join(tmp, "turn.json");
      const bf = path.join(tmp, "body.txt");
      fs.writeFileSync(tf, JSON.stringify({ role: "teacher", phase: "explain", step: 1 }));
      fs.writeFileSync(bf, "第1步：测试内容。\n引导：你觉得呢？");
      r = await post(`/turn?turn_file=${encodeURIComponent(tf)}&body_file=${encodeURIComponent(bf)}`);
      const turnResult = JSON.parse(r.body);
      t("提交 turn 成功", turnResult.ok === true && turnResult.turns === 1);
      t("state 落盘", JSON.parse(fs.readFileSync(sp, "utf8")).turns.length === 1);
      t("面板生成", fs.existsSync(op));

      // guard 拦截（泄底）
      fs.writeFileSync(tf, JSON.stringify({ role: "teacher", phase: "explain", body: "答案是42。" }));
      r = await post(`/turn?turn_file=${encodeURIComponent(tf)}`);
      const blocked = JSON.parse(r.body);
      t("guard 拦截泄底", blocked.ok === false && blocked.guard?.violations?.length > 0);
      t("拦截后 turns 不增加", JSON.parse(fs.readFileSync(sp, "utf8")).turns.length === 1);

      // event
      r = await post("/event?event=correct");
      t("event correct → review", JSON.parse(r.body).advanced?.phase === "review");

      // log
      r = await post("/log");
      t("log 写入成功", JSON.parse(r.body).ok === true);
      t("log 文件存在", fs.existsSync(lp));

      // 未知路由
      r = await get("/nope");
      t("未知路由 404", r.status === 404);

      // SSE 连接
      const ssePromise = new Promise((resolve) => {
        http.get(`${base}/live`, (res) => {
          let firstMsg = "";
          res.on("data", (c) => { firstMsg += c.toString(); if (firstMsg.includes("\n\n")) resolve(firstMsg); });
        });
      });
      const sseMsg = await ssePromise;
      t("SSE 连接并发送 connected", sseMsg.includes("connected"));

      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });

      let pass = 0;
      for (const c of cases) {
        if (c.cond) pass++;
        console.log(`${c.cond ? "✅" : "❌"} ${c.name}`);
      }
      console.log(`\n${pass}/${cases.length} 通过`);
      process.exit(pass === cases.length ? 0 : 1);
    })().catch((e) => {
      console.error("selftest 异常:", e);
      process.exit(1);
    });
  });
}

// ---- CLI ----

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const portIdx = argv.indexOf("--port");
    const port = portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : DEFAULT_PORT;
    start(port);
  }
}
