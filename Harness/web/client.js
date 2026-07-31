// LightningLoop web POC client.
// Drives the WebSocket at /run. Each phase of the loop maps to a UI section.
"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  connStatus: $("conn-status"),
  goal: $("goal"),
  runBtn: $("run-btn"),
  apiKey: $("api-key"),
  byoBase: $("byo-base"),
  byoModel: $("byo-model"),
  goalSection: $("goal-section"),
  clarifySection: $("clarify-section"),
  clarifySummary: $("clarify-summary"),
  clarifyQuestions: $("clarify-questions"),
  answerBtn: $("answer-btn"),
  loopSection: $("loop-section"),
  stageTracker: $("stage-tracker"),
  log: $("log"),
  cancelBtn: $("cancel-btn"),
  resultSection: $("result-section"),
  verdict: $("verdict"),
  deliverable: $("deliverable"),
  planDetail: $("plan-detail"),
  reviewsDetail: $("reviews-detail"),
  usageDetail: $("usage-detail"),
  againBtn: $("again-btn"),
  errorBanner: $("error-banner"),
};

let ws = null;

// ---- helpers -------------------------------------------------------------

function setConn(state) {
  els.connStatus.textContent = state;
  els.connStatus.className = "status " + (state === "connected" ? "live" : state === "disconnected" ? "dead" : "");
}

function show(section) {
  for (const s of [els.goalSection, els.clarifySection, els.loopSection, els.resultSection]) {
    s.hidden = true;
  }
  section.hidden = false;
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.hidden = false;
}
function clearError() {
  els.errorBanner.hidden = true;
}

function resetStages() {
  for (const li of els.stageTracker.children) {
    li.classList.remove("active", "done");
  }
}

// mark everything up to and including the given stage as done, the stage itself active
const STAGE_ORDER = ["planning", "reviewing_plan", "implementing", "reviewing_implementation", "gold"];
function setActiveStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx === -1) return; // stages we don't track (verifying, etc.) just go to the log
  for (let i = 0; i < els.stageTracker.children.length; i++) {
    const li = els.stageTracker.children[i];
    const liStage = li.dataset.stage;
    li.classList.remove("active", "done");
    if (i < idx) li.classList.add("done");
    else if (i === idx) {
      li.classList.add(idx === STAGE_ORDER.length - 1 ? "done" : "active");
    }
  }
}

function appendLog(event) {
  const round = event.round ? `[r${event.round}] ` : "";
  const role = event.role ? ` (${event.role})` : "";
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="tag">${event.stage}</span><span class="round">${round}</span>${escapeHtml(event.message)}${role ? `<span class="round">${role}</span>` : ""}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- websocket lifecycle -------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/run`);

  ws.onopen = () => {
    setConn("connected");
    els.runBtn.disabled = false;
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    setConn("disconnected");
    els.runBtn.disabled = true;
    // auto-reconnect so the UI recovers if the server restarts
    setTimeout(connect, 1500);
  };

  ws.onerror = () => { /* onclose will follow */ };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleMessage(msg) {
  clearError();
  switch (msg.type) {
    case "clarify":
      renderClarify(msg.clarification, msg.mode, msg.optionsByQuestion);
      show(els.clarifySection);
      break;
    case "stage":
      setActiveStage(msg.stage);
      appendLog(msg);
      break;
    case "result":
      renderResult(msg.result);
      break;
    case "error":
      showError(msg.message);
      break;
  }
}

// ---- phase 1: goal -> start ----------------------------------------------

function selectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "open_ended";
}

function startRun() {
  clearError();
  const goal = els.goal.value.trim();
  if (!goal) { showError("Enter a goal first."); return; }
  send({
    type: "start",
    goal,
    mode: selectedMode(),
    ...(els.apiKey.value.trim() ? { key: els.apiKey.value.trim() } : {}),
    ...(els.byoBase.value.trim() ? { baseURL: els.byoBase.value.trim() } : {}),
    ...(els.byoModel.value.trim() ? { model: els.byoModel.value.trim() } : {}),
  });
  // clear previous run artifacts
  els.log.textContent = "";
  resetStages();
}

// ---- phase 2: clarify ----------------------------------------------------

function renderClarify(clarification, mode, optionsByQuestion) {
  const isMC = mode === "multiple_choice";
  els.clarifySummary.textContent = clarification.summary || "";
  els.clarifyQuestions.innerHTML = "";
  for (const q of clarification.questions || []) {
    const wrap = document.createElement("div");
    wrap.className = "q";
    const whyHtml = q.whyItMatters ? `<div class="why">${escapeHtml(q.whyItMatters)}</div>` : "";
    if (isMC) {
      const opts = optionsByQuestion?.[q.id] ?? ["(brief answer)", "(detailed answer)"];
      const radios = opts.map((opt, i) => `
        <label><input type="radio" name="mc-${escapeHtml(q.id)}" value="${escapeHtml(opt)}" ${i === 0 ? "checked" : ""} /> ${escapeHtml(opt)}</label>
      `).join("");
      wrap.innerHTML = `
        <div class="qlabel">${escapeHtml(q.question)}</div>
        ${whyHtml}
        <div class="mc-options">${radios}</div>
      `;
    } else {
      wrap.innerHTML = `
        <div class="qlabel">${escapeHtml(q.question)}</div>
        ${whyHtml}
        <input type="text" data-qid="${escapeHtml(q.id)}" placeholder="Your answer…" />
      `;
    }
    els.clarifyQuestions.appendChild(wrap);
  }
}

function submitAnswers() {
  const answers = {};
  // multiple-choice: read selected radios
  for (const group of els.clarifyQuestions.querySelectorAll(".mc-options")) {
    const checked = group.querySelector("input[type='radio']:checked");
    const qid = checked?.name.replace(/^mc-/, "");
    if (qid) answers[qid] = checked.value;
  }
  // open-ended: read text inputs
  for (const input of els.clarifyQuestions.querySelectorAll("input[data-qid]")) {
    answers[input.dataset.qid] = input.value;
  }
  send({ type: "answers", answers });
  show(els.loopSection);
}

// ---- phase 3: result -----------------------------------------------------

function renderResult(result) {
  // finalize stage tracker
  for (const li of els.stageTracker.children) {
    li.classList.remove("active");
    li.classList.add("done");
  }

  if (result.stage === "gold") {
    els.verdict.textContent = "✦ GOLD ✦  — scored " + (result.reviews.at(-1)?.score ?? "?") + "/10, no blocking issues";
    els.verdict.className = "verdict gold";
  } else {
    els.verdict.textContent = "⏸ PAUSED — " + result.message;
    els.verdict.className = "verdict paused";
  }

  els.deliverable.textContent = result.implementation?.deliverable || "(no deliverable produced)";

  els.planDetail.textContent = JSON.stringify({
    criteria: result.planning?.criteria,
    plan: result.planning?.plan,
    acceptanceTest: result.planning?.acceptanceTest,
  }, null, 2);

  els.reviewsDetail.textContent = JSON.stringify(result.reviews, null, 2);

  const u = result.usage || {};
  els.usageDetail.textContent =
    `input tokens:  ${u.input ?? 0}\noutput tokens: ${u.output ?? 0}\ntotal tokens:  ${u.total ?? 0}\nreported cost: ${u.cost ?? 0}`;

  show(els.resultSection);
}

// ---- wiring --------------------------------------------------------------

function reset() {
  els.log.textContent = "";
  resetStages();
  clearError();
  show(els.goalSection);
  els.goal.focus();
}

els.runBtn.addEventListener("click", startRun);
els.goal.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) startRun(); });
els.answerBtn.addEventListener("click", submitAnswers);
els.cancelBtn.addEventListener("click", () => send({ type: "cancel" }));
els.againBtn.addEventListener("click", reset);

connect();
