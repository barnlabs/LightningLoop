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
  loopSection: $("loop-section"),
  loopTitle: $("loop-title"),
  stageTracker: $("stage-tracker"),
  log: $("log"),
  cancelBtn: $("cancel-btn"),
  resultSection: $("result-section"),
  verdict: $("verdict"),
  deliverable: $("deliverable"),
  againBtn: $("again-btn"),
  feedbackSection: $("feedback-section"),
  followup: $("followup"),
  followupSubmit: $("followup-submit"),
  followupDone: $("followup-done"),
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
  for (const s of [els.goalSection, els.classifySection, els.loopSection, els.resultSection, els.feedbackSection]) s.hidden = true;
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
  // Don't surface internal jargon (subjective/factual) to the user. Only show
  // a visible badge when a goal is blocked as harmful.
  if (classification === "harmful") {
    els.classificationBadge.className = "badge bad";
    els.classificationBadge.textContent = `⛔ Blocked — ${reason}`;
  } else {
    els.classificationBadge.className = "badge";
    els.classificationBadge.textContent = "";
    els.classificationBadge.hidden = true;
  }
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

// Slideshow state for clarifying questions
let slideQuestions = [];
let slideOptions = {};
let slideMode = "open_ended";
let slideIndex = 0;
let slideAnswers = {};

function renderClarify(clarification, mode, optionsByQuestion, classification) {
  currentMode = classification;
  const stages = classification === "factual" ? FACTUAL_STAGES : SUBJECTIVE_STAGES;
  buildStageTracker(stages);

  slideQuestions = clarification.questions || [];
  slideOptions = optionsByQuestion || {};
  slideMode = mode;
  slideIndex = 0;
  slideAnswers = {};
  els.clarifySummary.textContent = clarification.summary || "";
  renderSlide();
}

function renderSlide() {
  const total = slideQuestions.length;
  if (total === 0) { submitAnswers(); return; }
  const q = slideQuestions[slideIndex];
  const isMC = slideMode === "multiple_choice";
  const why = q.whyItMatters ? `<div class="why">${escapeHtml(q.whyItMatters)}</div>` : "";

  let inputHtml;
  if (isMC) {
    const opts = slideOptions[q.id] ?? ["(brief)", "(detailed)"];
    const prev = slideAnswers[q.id];
    inputHtml = `<div class="mc-options">${opts.map((o) => `<label><input type="radio" name="slide" value="${escapeHtml(o)}" ${prev === o ? "checked" : ""} /> ${escapeHtml(o)}</label>`).join("")}</div>`;
  } else {
    inputHtml = `<input type="text" id="slide-input" placeholder="Your answer…" value="${escapeHtml(slideAnswers[q.id] ?? "")}" />`;
  }

  els.clarifyQuestions.innerHTML = `
    <div class="slide-progress">Question ${slideIndex + 1} of ${total}</div>
    <div class="slide-q">
      <div class="qlabel">${escapeHtml(q.question)}</div>
      ${why}
      ${inputHtml}
    </div>
    <div class="slide-nav">
      <input type="button" id="slide-back" value="‹ Back" ${slideIndex === 0 ? "disabled" : ""} />
      ${slideIndex < total - 1
        ? `<input type="button" id="slide-next" value="Next ›" />`
        : `<input type="button" id="slide-finish" value="Get my answer ▸" />`}
    </div>
  `;

  const next = $("slide-next");
  const finish = $("slide-finish");
  const back = $("slide-back");
  if (next) next.addEventListener("click", saveAndAdvance);
  if (finish) finish.addEventListener("click", saveAndFinish);
  if (back) back.addEventListener("click", () => { saveCurrent(); slideIndex--; renderSlide(); });
  const inp = $("slide-input");
  if (inp) { inp.focus(); inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCurrent(); slideIndex < total - 1 ? saveAndAdvance() : saveAndFinish(); } }); }
  const radios = els.clarifyQuestions.querySelectorAll("input[name='slide']");
  radios.forEach((r) => r.addEventListener("change", () => { slideAnswers[q.id] = r.value; if (next) saveAndAdvance(); else if (finish) saveAndFinish(); }));
}

function saveCurrent() {
  const q = slideQuestions[slideIndex];
  if (!q) return;
  const inp = $("slide-input");
  if (inp) slideAnswers[q.id] = inp.value;
}

function saveAndAdvance() {
  saveCurrent();
  if (slideIndex < slideQuestions.length - 1) { slideIndex++; renderSlide(); }
}
function saveAndFinish() {
  saveCurrent();
  submitAnswers();
}

function submitAnswers() {
  send({ type: "answers", answers: slideAnswers });
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
  // Show the answer, then the feedback section below it (skip feedback for refusals).
  show(els.resultSection);
  if (!result.message?.startsWith("Refused")) {
    els.feedbackSection.hidden = false;
    els.followup.value = "";
    document.querySelectorAll("input[name='rating']").forEach((r) => { r.checked = false; });
  }
}

function reset() { els.log.textContent = ""; clearError(); show(els.goalSection); els.goal.focus(); }

function submitFollowup() {
  const question = els.followup.value.trim();
  if (!question) { showError("Type a follow-up question first."); return; }
  const rating = document.querySelector('input[name="rating"]:checked')?.value;
  clearError();
  send({ type: "followup", question, ...(rating ? { rating } : {}) });
  els.feedbackSection.hidden = true;
  show(els.loopSection);
  els.loopTitle.textContent = "Refining the answer…";
}

els.runBtn.addEventListener("click", startRun);
els.goal.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) startRun(); });
els.cancelBtn.addEventListener("click", () => send({ type: "cancel" }));
els.againBtn.addEventListener("click", reset);
els.followupDone.addEventListener("click", reset);
els.followupSubmit.addEventListener("click", submitFollowup);
connect();
