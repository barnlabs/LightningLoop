// LightningLoop web client — 4-stroke flow driver.
"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  connStatus: $("conn-status"),
  goal: $("goal"),
  runBtn: $("run-btn"),
  goalSection: $("goal-section"),
  classifySection: $("clarify-section"),
  classificationBadge: $("classification-badge"),
  clarifySummary: $("clarify-summary"),
  clarifyQuestions: $("clarify-questions"),
  answerBtn: $("answer-btn"),
  loopSection: $("loop-section"),
  loopTitle: $("loop-title"),
  stageTracker: $("stage-tracker"),
  log: $("log"),
  cancelBtn: $("cancel-btn"),
  resultSection: $("result-section"),
  verdict: $("verdict"),
  deliverable: $("deliverable"),
  notesDetail: $("notes-detail"),
  planDetail: $("plan-detail"),
  reviewsDetail: $("reviews-detail"),
  againBtn: $("again-btn"),
  errorBanner: $("error-banner"),
};

let ws = null;
let currentMode = "open_ended";

const SUBJECTIVE_STAGES = ["clarifying", "implementing", "reviewing_implementation", "gold"];
const FACTUAL_STAGES = ["planning", "reviewing_plan", "implementing", "reviewing_implementation", "gold"];

function setConn(state) {
  els.connStatus.textContent = state;
  els.connStatus.className = "status " + (state === "connected" ? "live" : "dead");
}

function show(section) {
  for (const s of [els.goalSection, els.classifySection, els.loopSection, els.resultSection]) s.hidden = true;
  section.hidden = false;
}

function showError(m) { els.errorBanner.textContent = m; els.errorBanner.hidden = false; }
function clearError() { els.errorBanner.hidden = true; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function buildStageTracker(stages) {
  els.stageTracker.innerHTML = "";
  for (const s of stages) {
    const li = document.createElement("li");
    li.dataset.stage = s;
    const labels = { clarifying: "Classify", planning: "Plan", reviewing_plan: "Review plan", implementing: "Answer", reviewing_implementation: "Honesty check", gold: "Done" };
    li.textContent = labels[s] ?? s;
    els.stageTracker.appendChild(li);
  }
}

function setActiveStage(stage, stages) {
  const idx = stages.indexOf(stage);
  if (idx === -1) return;
  for (let i = 0; i < els.stageTracker.children.length; i++) {
    const li = els.stageTracker.children[i];
    li.classList.remove("active", "done");
    if (i < idx) li.classList.add("done");
    else if (i === idx) li.classList.add(i === stages.length - 1 ? "done" : "active");
  }
}

function appendLog(event) {
  const round = event.round ? `[r${event.round}] ` : "";
  const att = event.attempt ? `[att${event.attempt}] ` : "";
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="tag">${escapeHtml(event.stage)}</span><span class="round">${att}${round}</span>${escapeHtml(event.message)}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/run`);
  ws.onopen = () => { setConn("connected"); els.runBtn.disabled = false; };
  ws.onmessage = (ev) => { try { handleMessage(JSON.parse(ev.data)); } catch {} };
  ws.onclose = () => { setConn("disconnected"); els.runBtn.disabled = true; setTimeout(connect, 1500); };
  ws.onerror = () => {};
}

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function handleMessage(msg) {
  clearError();
  switch (msg.type) {
    case "classified":
      renderBadge(msg.classification, msg.reason);
      break;
    case "clarify":
      renderClarify(msg.clarification, msg.mode, msg.optionsByQuestion, msg.classification);
      show(els.classifySection);
      break;
    case "stage":
      appendLog(msg);
      const stages = currentMode === "factual" ? FACTUAL_STAGES : SUBJECTIVE_STAGES;
      setActiveStage(msg.stage, stages);
      break;
    case "result":
      renderResult(msg.result);
      break;
    case "error":
      showError(msg.message);
      break;
  }
}

function renderBadge(classification, reason) {
  const labels = {
    harmful: { text: "Blocked", cls: "bad", icon: "⛔" },
    subjective: { text: "Subjective — will answer in your terms", cls: "warn", icon: "💭" },
    factual: { text: "Factual — strict verification", cls: "good", icon: "✓" },
  };
  const l = labels[classification] ?? labels.subjective;
  els.classificationBadge.className = `badge ${l.cls}`;
  els.classificationBadge.textContent = `${l.icon} ${l.text} — ${reason}`;
}

function startRun() {
  clearError();
  const goal = els.goal.value.trim();
  if (!goal) { showError("Enter a question first."); return; }
  currentMode = document.querySelector('input[name="mode"]:checked')?.value ?? "open_ended";
  els.log.textContent = "";
  send({ type: "start", goal, mode: currentMode });
  els.loopTitle.textContent = "Classifying…";
  buildStageTracker(SUBJECTIVE_STAGES);
  show(els.loopSection);
}

function renderClarify(clarification, mode, optionsByQuestion, classification) {
  currentMode = classification;
  const stages = classification === "factual" ? FACTUAL_STAGES : SUBJECTIVE_STAGES;
  els.loopTitle.textContent = classification === "factual" ? "Strict verification run" : "Answering in your terms";
  buildStageTracker(stages);

  els.clarifySummary.textContent = clarification.summary || "";
  els.clarifyQuestions.innerHTML = "";
  const isMC = mode === "multiple_choice";
  for (const q of clarification.questions || []) {
    const wrap = document.createElement("div");
    wrap.className = "q";
    const why = q.whyItMatters ? `<div class="why">${escapeHtml(q.whyItMatters)}</div>` : "";
    if (isMC) {
      const opts = optionsByQuestion?.[q.id] ?? ["(brief)", "(detailed)"];
      const radios = opts.map((o, i) => `<label><input type="radio" name="mc-${escapeHtml(q.id)}" value="${escapeHtml(o)}" ${i === 0 ? "checked" : ""} /> ${escapeHtml(o)}</label>`).join("");
      wrap.innerHTML = `<div class="qlabel">${escapeHtml(q.question)}</div>${why}<div class="mc-options">${radios}</div>`;
    } else {
      wrap.innerHTML = `<div class="qlabel">${escapeHtml(q.question)}</div>${why}<input type="text" data-qid="${escapeHtml(q.id)}" placeholder="Your answer…" />`;
    }
    els.clarifyQuestions.appendChild(wrap);
  }
}

function submitAnswers() {
  const answers = {};
  for (const g of els.clarifyQuestions.querySelectorAll(".mc-options")) {
    const c = g.querySelector("input[type='radio']:checked");
    const qid = c?.name.replace(/^mc-/, "");
    if (qid) answers[qid] = c.value;
  }
  for (const input of els.clarifyQuestions.querySelectorAll("input[data-qid]")) answers[input.dataset.qid] = input.value;
  send({ type: "answers", answers });
  show(els.loopSection);
}

function renderResult(result) {
  for (const li of els.stageTracker.children) { li.classList.remove("active"); li.classList.add("done"); }
  if (result.stage === "gold") {
    els.verdict.textContent = "✦ Answer ✦";
    els.verdict.className = "verdict gold";
  } else if (result.message?.startsWith("Refused")) {
    els.verdict.textContent = "⛔ Refused";
    els.verdict.className = "verdict paused";
  } else {
    els.verdict.textContent = "⏸ Paused — " + (result.message || "");
    els.verdict.className = "verdict paused";
  }
  els.deliverable.textContent = result.implementation?.deliverable || "(no answer)";
  els.notesDetail.textContent = JSON.stringify(result.implementation?.notes ?? [], null, 2);
  els.planDetail.textContent = JSON.stringify({ criteria: result.planning?.criteria, plan: result.planning?.plan }, null, 2);
  els.reviewsDetail.textContent = JSON.stringify(result.reviews, null, 2);
  show(els.resultSection);
}

function reset() { els.log.textContent = ""; clearError(); show(els.goalSection); els.goal.focus(); }

els.runBtn.addEventListener("click", startRun);
els.goal.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) startRun(); });
els.answerBtn.addEventListener("click", submitAnswers);
els.cancelBtn.addEventListener("click", () => send({ type: "cancel" }));
els.againBtn.addEventListener("click", reset);
connect();
