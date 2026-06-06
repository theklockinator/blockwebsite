import { isValidPattern } from "../lib/patterns.js";
import {
  formatCountdown,
  formatMsAsMmSs,
  getUnblockRemainingMs,
  parseEmergencyTimeInput,
} from "../lib/time-format.js";

const patternInput = document.getElementById("pattern-input");
const addPatternBtn = document.getElementById("add-pattern");
const patternList = document.getElementById("pattern-list");
const emergencyMinutes = document.getElementById("emergency-minutes");
const blockEnd = document.getElementById("block-end");
const startBtn = document.getElementById("start-btn");
const statusBadge = document.getElementById("status-badge");
const blockUntil = document.getElementById("block-until");
const emergencyRemaining = document.getElementById("emergency-remaining");
const setupSection = document.getElementById("setup-section");
const scheduleSection = document.getElementById("schedule-section");
const errorEl = document.getElementById("error");
const unblockCountdown = document.getElementById("unblock-countdown");

let patterns = [];
let countdownTimer = null;

function showError(message) {
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = "";
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function toDatetimeLocalValue(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultEndTime() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return toDatetimeLocalValue(d);
}

function readEmergencyInput() {
  return parseEmergencyTimeInput(emergencyMinutes.value);
}

function renderPatterns() {
  patternList.innerHTML = "";
  patterns.forEach((pattern, index) => {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = pattern;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removePattern(index));
    li.append(code, remove);
    patternList.appendChild(li);
  });
}

async function persistPatterns() {
  await chrome.runtime.sendMessage({ type: "UPDATE_PATTERNS", patterns });
}

async function addPattern() {
  const value = patternInput.value.trim();
  if (!isValidPattern(value)) {
    showError("Enter a valid hostname pattern (e.g. *.google.*).");
    return;
  }
  if (patterns.includes(value)) {
    showError("Pattern already exists.");
    return;
  }
  patterns.push(value);
  patternInput.value = "";
  showError("");
  renderPatterns();
  await persistPatterns();
}

async function removePattern(index) {
  patterns.splice(index, 1);
  renderPatterns();
  await persistPatterns();
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  unblockCountdown.hidden = true;
  unblockCountdown.textContent = "";
}

function updateCountdown(blockEndTime) {
  const remaining = getUnblockRemainingMs(blockEndTime);
  if (remaining <= 0) {
    stopCountdown();
    loadStatus();
    return;
  }
  unblockCountdown.hidden = false;
  unblockCountdown.innerHTML = `Unblocks in<strong>${formatCountdown(remaining)}</strong>`;
}

function startCountdown(blockEndTime) {
  stopCountdown();
  if (!blockEndTime) return;
  updateCountdown(blockEndTime);
  countdownTimer = setInterval(() => updateCountdown(blockEndTime), 1000);
}

function setBlockingUI(active, settings) {
  if (active) {
    statusBadge.textContent = "Blocking active";
    statusBadge.className = "badge active";
    startBtn.textContent = "Blocking in progress";
    startBtn.disabled = true;
    setupSection.classList.add("locked");
    emergencyMinutes.disabled = true;
    blockEnd.disabled = true;
    blockUntil.textContent = settings.blockEndTime
      ? `Scheduled stop: ${formatDateTime(settings.blockEndTime)}`
      : "";
    startCountdown(settings.blockEndTime);
  } else {
    stopCountdown();
    statusBadge.textContent = "Not blocking";
    statusBadge.className = "badge idle";
    startBtn.textContent = "Start blocking";
    startBtn.disabled = false;
    setupSection.classList.remove("locked");
    emergencyMinutes.disabled = false;
    blockEnd.disabled = false;
    blockUntil.textContent = "";
    if (!blockEnd.value) blockEnd.value = defaultEndTime();
  }
}

async function saveDraftSettings() {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (status.blockingActive) return;

  const parsed = readEmergencyInput();
  const blockEndTime = blockEnd.value
    ? new Date(blockEnd.value).toISOString()
    : null;

  const draft = { blockEndTime };
  if (parsed.ok) {
    draft.emergencyAllowanceMs = parsed.ms;
  }

  await chrome.storage.local.set(draft);
}

function normalizeEmergencyInputOnBlur() {
  const parsed = readEmergencyInput();
  if (parsed.ok) {
    emergencyMinutes.value = formatMsAsMmSs(parsed.ms);
  }
}

async function loadStatus() {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  patterns = status.patterns || [];
  emergencyMinutes.value = formatMsAsMmSs(
    status.emergencyAllowanceMs ?? 15 * 60 * 1000
  );
  if (status.blockEndTime) {
    blockEnd.value = toDatetimeLocalValue(status.blockEndTime);
  } else {
    blockEnd.value = defaultEndTime();
  }

  renderPatterns();
  setBlockingUI(status.blockingActive, status);

  if (status.blockingActive) {
    emergencyRemaining.textContent = `${formatMsAsMmSs(status.emergencyRemainingMs)} emergency time left today`;
  } else {
    emergencyRemaining.textContent = `Daily allowance: ${emergencyMinutes.value}`;
  }
}

async function startBlocking() {
  showError("");
  if (!patterns.length) {
    showError("Add at least one pattern before starting.");
    return;
  }

  const parsed = readEmergencyInput();
  if (!parsed.ok) {
    showError(parsed.error);
    return;
  }

  if (!blockEnd.value) {
    showError("Choose a date and time to stop blocking.");
    return;
  }

  const endMs = new Date(blockEnd.value).getTime();
  if (!Number.isFinite(endMs) || endMs <= Date.now()) {
    showError("Stop time must be in the future.");
    return;
  }

  const blockEndTime = new Date(blockEnd.value).toISOString();
  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "START_BLOCKING",
      patterns,
      emergencyAllowanceMs: parsed.ms,
      blockEndTime,
    });
  } catch (err) {
    showError(err?.message || "Could not reach the extension background.");
    return;
  }

  if (!result?.ok) {
    showError(result?.error || "Could not start blocking.");
    return;
  }

  emergencyMinutes.value = formatMsAsMmSs(parsed.ms);
  await loadStatus();
}

addPatternBtn.addEventListener("click", addPattern);
patternInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addPattern();
});
startBtn.addEventListener("click", startBlocking);
emergencyMinutes.addEventListener("change", () => {
  normalizeEmergencyInputOnBlur();
  saveDraftSettings();
});
emergencyMinutes.addEventListener("blur", normalizeEmergencyInputOnBlur);
blockEnd.addEventListener("change", saveDraftSettings);
window.addEventListener("unload", stopCountdown);

loadStatus();
