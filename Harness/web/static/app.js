// LightningLoop — browser-only static version (no server, runs on GitHub Pages).
// The user pastes their own API key; it lives only in their browser session
// (localStorage) and is sent directly to their provider. Never touches our
// server because there is no server.
"use strict";

// ─── Provider config (stored in localStorage) ──────────────────────────────
const STORAGE_KEY = "lightningloop-provider";
function loadProvider() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}
function saveProvider(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }

function getProvider() {
  const p = loadProvider();
  return {
    baseURL: (p.baseURL || "").replace(/\/+$/, ""),
    apiKey: p.apiKey || "",
    model: p.model || "",
  };
}

// ─── Anthropic Messages API (direct browser call) ─────────────────────────
async function callLLM(system, user, { temperature = 0.4, maxTokens = 1500 } = {}) {
  const { baseURL, apiKey, model } = getProvider();
  if (!baseURL || !apiKey || !model) throw new Error("Enter your provider details in Settings first.");
  // Anthropic requires this header for browser/CORS calls.
  const res = await fetch(`${baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: Math.min(maxTokens, 8192), temperature, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Provider error (status ${res.status})`);
  }
  const json = await res.json();
  const text = (json.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  return { text: extractJSON(text), usage: json.usage || {} };
}

// ─── JSON tolerance (mirrors the server adapter) ───────────────────────────
function extractJSON(content) {
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence && fence[1]) text = fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return content;
  const open = text[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return content;
}
function parseJSON(text) { try { return JSON.parse(extractJSON(text)); } catch { return null; } }

// ─── 4-stroke flow ─────────────────────────────────────────────────────────
async function classifyGoal(goal) {
  const r = await callLLM([
    "You classify a user's question into exactly one category. Respond with ONLY a JSON object, no prose.",
    "Categories:",
    '- "harmful": ranks/judges/demeans people by race, ethnicity, religion, gender, sexuality, disability, or nationality; promotes hate, violence, or supremacy.',
    '- "subjective": depends on personal preference, taste, or opinion. No single objectively-correct answer.',
    '- "factual": a verifiable fact backed by a specific source.',
    'Return exactly: {"classification":"harmful|subjective|factual","reason":"one short sentence","reframe":"optional, only for harmful"}',
  ].join("\n"), `Classify this question:\n${goal}`, { temperature: 0, maxTokens: 300 });
  const p = parseJSON(r.text) || {};
  return { classification: ["harmful","subjective","factual"].includes(p.classification) ? p.classification : "subjective", reason: p.reason || "Unclassified.", reframe: p.reframe };
}

async function clarifySubjective(goal) {
  const r = await callLLM([
    "You ask clarifying questions that make a subjective question answerable.",
    "Think about: who is involved (people, needs, dietary requirements), constraints (budget, location, time), scenario (casual, special occasion).",
    "Ask only questions whose answers would change the recommendation.",
    'Return ONLY: {"summary":"...","questions":[{"id":"Q1","question":"...","why_it_matters":"..."}, ...]}',
    "You MUST ask at least 5 questions. Aim for 6.",
  ].join("\n"), `Question to clarify:\n${goal}`, { temperature: 0.3, maxTokens: 800 });
  const p = parseJSON(r.text) || {};
  return { summary: p.summary || goal, questions: (p.questions || []).filter(q => q.question).slice(0, 6) };
}

async function answerSubjective(goal, clarification, answers) {
  const answersText = clarification.questions.map((q) => `Q: ${q.question}\nA: ${answers[q.id] || "(no answer)"}`).join("\n");
  const r = await callLLM([
    "You are a thorough expert answering a question in the user's own terms. Research and reason in depth before answering.",
    "HONESTY IS THE TOP PRIORITY. Never invent or fabricate.",
    "DEPTH OF RESEARCH — work through these steps in your reasoning before writing the final answer:",
    "1. RECALL: What do you actually know about this from your training? Pull up the relevant facts, definitions, and context.",
    "2. ANGLES: Consider the question from multiple viewpoints (cost, quality, convenience, the user's stated parameters, edge cases). Don't just give the first answer that comes to mind.",
    "3. ALTERNATIVES: What are the realistic alternatives or trade-offs? Weigh them honestly.",
    "4. VERIFY: Cross-check any specific claim against what you genuinely know. If you're unsure a detail is real, treat it as uncertain.",
    "5. TAILOR: Apply the user's clarifying answers as hard constraints. Reject options that violate them.",
    "OUTPUT RULES:",
    "- Do NOT invent specific named entities (businesses, addresses, prices, hours, URLs) unless genuinely certain they are real. Describe types of places when you can't verify a specific one.",
    "- Do not invent facts, sources, statistics, or quotes.",
    "- Lead with the direct answer, then the reasoning and the trade-offs.",
    "- If you genuinely don't know something concrete, say so plainly rather than guessing.",
    "Be useful. A real, well-reasoned answer beats a refusal — but an honest answer beats a confident fabrication.",
  ].join("\n"), `Goal: ${goal}\n\nClarifying answers (the user's parameters — treat as constraints):\n${answersText}\n\nProvide a direct, helpful, well-reasoned answer. Show your reasoning, then the recommendation.`, { temperature: 0.4, maxTokens: 2500 });
  return r;
}

async function reviewHonesty(goal, answer) {
  const r = await callLLM([
    "You are a rigorous honesty reviewer. Catch FABRICATION.",
    'Return ONLY: {"addressed":true|false,"judgment_notes":"...","uncertainty":"...","named_entities":"...","fabrication_risk":"none|low|high","correction":"if high, a warning"}',
    "fabrication_risk = HIGH if specific businesses/addresses/URLs may not be real. LOW if only famous places or types. NONE if no named entities.",
    "Be strict. When in doubt, set high and write a correction warning the user to verify.",
  ].join("\n"), `Question: ${goal}\n\nAnswer:\n${answer}`, { temperature: 0, maxTokens: 500 });
  return parseJSON(r.text) || { addressed: true, fabrication_risk: "low" };
}

// ─── UI wiring ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  settings: $("settings"), settingsToggle: $("settings-toggle"),
  baseURL: $("baseURL"), apiKey: $("api-key"), model: $("model"), saveSettings: $("save-settings"),
  goalSection: $("goal-section"), goal: $("goal"),
  runBtn: $("run-btn"), status: $("status"),
  clarifySection: $("clarify-section"), clarifySummary: $("clarify-summary"), clarifyQuestions: $("clarify-questions"),
  loopSection: $("loop-section"), log: $("log"), cancelBtn: $("cancel-btn"),
  resultSection: $("result-section"), verdict: $("verdict"), deliverable: $("deliverable"),
  againBtn: $("again-btn"), feedback: $("feedback-section"),
  followup: $("followup"), followupSubmit: $("followup-submit"), followupDone: $("followup-done"),
  error: $("error-banner"),
};

let mode = "open_ended", slides = [], slideIdx = 0, slideAnswers = {}, lastGoal = "", lastAnswer = "";

function show(s) { for (const el of [els.goalSection, els.clarifySection, els.loopSection, els.resultSection, els.feedback]) el.hidden = true; s.hidden = false; }
function err(m) { els.error.textContent = m; els.error.hidden = false; }
function clearErr() { els.error.hidden = true; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function log(msg) { const d = document.createElement("div"); d.textContent = msg; els.log.appendChild(d); els.log.scrollTop = els.log.scrollHeight; }

function renderMarkdown(md) {
  const lines = esc(md).split("\n"); let h = "", inList = false;
  const cl = () => { if (inList) { h += "</ul>"; inList = false; } };
  const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>");
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s/.test(line)) { cl(); const l = line.match(/^(#{1,3})/)[1].length; h += `<h${l+2}>${inline(line.replace(/^#{1,3}\s/,""))}</h${l+2}>`; }
    else if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) { if (!inList) { h+="<ul>"; inList=true; } h += `<li>${inline(line.replace(/^([-*]|\d+\.)\s/,""))}</li>`; }
    else if (line.trim() === "") cl();
    else { cl(); h += `<p>${inline(line)}</p>`; }
  }
  cl(); return h;
}

function loadSettings() {
  const p = getProvider();
  els.baseURL.value = p.baseURL; els.apiKey.value = p.apiKey; els.model.value = p.model;
}

async function startRun() {
  clearErr();
  const goal = els.goal.value.trim();
  if (!goal) { err("Enter a question first."); return; }
  if (!getProvider().apiKey) { err("Enter your API key in Settings first."); els.settings.hidden = false; return; }
  mode = document.querySelector('input[name="mode"]:checked')?.value || "open_ended";
  els.log.innerHTML = ""; show(els.loopSection);
  lastGoal = goal;
  try {
    log("Classifying the question…");
    const c = await classifyGoal(goal);
    if (c.classification === "harmful") {
      show(els.resultSection);
      els.verdict.textContent = "⛔ Refused"; els.verdict.className = "verdict paused";
      els.deliverable.textContent = `I won't help with that. ${c.reason}${c.reframe ? " " + c.reframe : ""}`;
      return;
    }
    log("Asking clarifying questions…");
    const cl = await clarifySubjective(goal);
    renderClarify(cl);
    show(els.clarifySection);
  } catch (e) { err(e.message); }
}

function renderClarify(cl) {
  els.clarifySummary.textContent = cl.summary || "";
  slides = cl.questions; slideIdx = 0; slideAnswers = {};
  renderSlide();
}
function renderSlide() {
  const q = slides[slideIdx]; if (!q) return;
  const why = q.why_it_matters ? `<div class="why">${esc(q.why_it_matters)}</div>` : "";
  const prev = slideAnswers[q.id] || "";
  els.clarifyQuestions.innerHTML = `
    <div class="slide-progress">Question ${slideIdx + 1} of ${slides.length}</div>
    <div class="qlabel">${esc(q.question)}</div>${why}
    <input type="text" id="slide-input" placeholder="Your answer…" value="${esc(prev)}">
    <div class="slide-nav">
      <button id="slide-back" ${slideIdx === 0 ? "disabled" : ""}>‹ Back</button>
      ${slideIdx < slides.length - 1 ? '<button id="slide-next">Next ›</button>' : '<button id="slide-finish">Get my answer ▸</button>'}
    </div>`;
  const inp = $("slide-input"); inp.focus();
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("slide-next")?.click() || $("slide-finish")?.click(); }});
  $("slide-back")?.addEventListener("click", () => { slideAnswers[q.id] = inp.value; slideIdx--; renderSlide(); });
  $("slide-next")?.addEventListener("click", () => { slideAnswers[q.id] = inp.value; slideIdx++; renderSlide(); });
  $("slide-finish")?.addEventListener("click", () => { slideAnswers[q.id] = inp.value; show(els.loopSection); runAnswer(); });
}

async function runAnswer() {
  log("Composing your answer…");
  try {
    const cl = { summary: "", questions: slides };
    const reply = await answerSubjective(lastGoal, cl, slideAnswers);
    lastAnswer = reply.text;
    log("Honesty check…");
    const review = await reviewHonesty(lastGoal, reply.text);
    let deliverable = reply.text;
    if (review.fabrication_risk === "high") {
      deliverable += `\n\n---\n\n⚠️ **Honesty check:** ${review.correction || "The named specifics above may not be real — verify before relying on them."}`;
    }
    show(els.resultSection);
    els.verdict.textContent = "✦ Answer ✦"; els.verdict.className = "verdict gold";
    els.deliverable.innerHTML = renderMarkdown(deliverable);
    els.feedback.hidden = false;
  } catch (e) { err(e.message); }
}

els.runBtn.addEventListener("click", startRun);
els.goal.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) startRun(); });
els.againBtn.addEventListener("click", () => { els.log.innerHTML = ""; clearErr(); show(els.goalSection); els.goal.focus(); });
els.settingsToggle.addEventListener("click", () => { els.settings.hidden = !els.settings.hidden; });
els.saveSettings.addEventListener("click", () => {
  saveProvider({ baseURL: els.baseURL.value.trim(), apiKey: els.apiKey.value.trim(), model: els.model.value.trim() });
  els.settings.hidden = true;
  els.status.textContent = getProvider().apiKey ? "ready" : "no key";
});
els.followupDone.addEventListener("click", () => { els.log.innerHTML = ""; show(els.goalSection); els.goal.focus(); });
els.followupSubmit.addEventListener("click", async () => {
  const q = els.followup.value.trim(); if (!q) { err("Type a follow-up first."); return; }
  clearErr();
  try {
    show(els.loopSection); log("Refining…");
    const r = await callLLM("You refine a previous answer based on the user's follow-up. Be factual. Do not invent.", `Original: ${lastGoal}\n\nPrevious answer:\n${lastAnswer}\n\nFollow-up: ${q}\n\nProvide a refined answer.`, { temperature: 0.4, maxTokens: 1500 });
    lastAnswer = r.text;
    show(els.resultSection);
    els.deliverable.innerHTML = renderMarkdown(r.text);
  } catch (e) { err(e.message); }
});

loadSettings();
els.status.textContent = getProvider().apiKey ? "ready" : "no key — open Settings";
