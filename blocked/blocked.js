import {
  formatCountdown,
  formatMsAsMmSs,
  getUnblockRemainingMs,
} from "../lib/time-format.js";

const params = new URLSearchParams(window.location.search);
const blockedUrl = params.get("url") || "";
const expired = params.get("expired") === "1";

const urlEl = document.getElementById("blocked-url");
const messageEl = document.getElementById("message");
const remainingEl = document.getElementById("remaining");
const emergencyBtn = document.getElementById("emergency-btn");
const errorEl = document.getElementById("error");
const unblockCountdown = document.getElementById("unblock-countdown");
const countdownValue = document.getElementById("countdown-value");

let countdownTimer = null;

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

async function refreshRemaining() {
  const { remainingMs } = await chrome.runtime.sendMessage({
    type: "GET_EMERGENCY_REMAINING",
  });
  remainingEl.textContent = `${formatMsAsMmSs(remainingMs)} remaining today`;
  emergencyBtn.disabled = remainingMs <= 0;
  return remainingMs;
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  unblockCountdown.hidden = true;
}

function updateCountdown(blockEndTime) {
  const remaining = getUnblockRemainingMs(blockEndTime);
  if (remaining <= 0) {
    stopCountdown();
    checkBlockingEnded();
    return;
  }
  unblockCountdown.hidden = false;
  countdownValue.textContent = formatCountdown(remaining);
}

async function startCountdown() {
  stopCountdown();
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!status.blockingActive || !status.blockEndTime) return;

  updateCountdown(status.blockEndTime);
  countdownTimer = setInterval(() => updateCountdown(status.blockEndTime), 1000);
}

urlEl.textContent = blockedUrl;

if (expired) {
  messageEl.textContent = "Your emergency access time for today has run out.";
}

refreshRemaining();
startCountdown();

async function checkBlockingEnded() {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!status.blockingActive && blockedUrl) {
    window.location.replace(blockedUrl);
  }
}

setInterval(checkBlockingEnded, 30_000);
checkBlockingEnded();

window.addEventListener("unload", stopCountdown);

emergencyBtn.addEventListener("click", async () => {
  showError("");
  emergencyBtn.disabled = true;

  const tab = await chrome.tabs.getCurrent();
  const result = await chrome.runtime.sendMessage({
    type: "GRANT_EMERGENCY",
    tabId: tab.id,
    url: blockedUrl,
  });

  if (!result.ok) {
    showError(result.error || "Could not grant emergency access.");
    await refreshRemaining();
    return;
  }

  // Background navigates the tab to the target URL.
});
