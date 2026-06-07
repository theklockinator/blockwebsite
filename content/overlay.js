(function () {
  const ROOT_ID = "blockwebsite-overlay-root";

  let countdownTimer = null;
  let emergencyPollTimer = null;
  let blockEndTime = null;
  let scrollLockCleanup = null;
  let trapCleanup = null;

  function formatMsAsMmSs(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return "0:00";
    const totalSeconds = Math.ceil(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (days > 0) return `${days}d ${hours}:${pad(minutes)}:${pad(seconds)}`;
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${minutes}:${pad(seconds)}`;
  }

  function getUnblockRemainingMs(endTime) {
    const end = new Date(endTime).getTime();
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, end - Date.now());
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function stopEmergencyPoll() {
    if (emergencyPollTimer) {
      clearInterval(emergencyPollTimer);
      emergencyPollTimer = null;
    }
  }

  function lockPageInteraction() {
    document.documentElement.classList.add("blockwebsite-overlay-active");
    document.body.setAttribute("inert", "");

    const blockScroll = (event) => {
      if (!document.getElementById(ROOT_ID)) return;
      event.preventDefault();
    };

    const blockKeys = (event) => {
      const root = document.getElementById(ROOT_ID);
      if (!root || root.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("wheel", blockScroll, { passive: false, capture: true });
    document.addEventListener("touchmove", blockScroll, { passive: false, capture: true });
    document.addEventListener("keydown", blockKeys, { capture: true });

    scrollLockCleanup = () => {
      document.documentElement.classList.remove("blockwebsite-overlay-active");
      document.body.removeAttribute("inert");
      document.removeEventListener("wheel", blockScroll, { capture: true });
      document.removeEventListener("touchmove", blockScroll, { capture: true });
      document.removeEventListener("keydown", blockKeys, { capture: true });
      scrollLockCleanup = null;
    };
  }

  function setupFocusTrap(root, emergencyBtn) {
    const getFocusable = () =>
      [...root.querySelectorAll("button:not(:disabled), [tabindex]:not([tabindex='-1'])")];

    const onKeyDown = (event) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    emergencyBtn.focus();

    trapCleanup = () => {
      root.removeEventListener("keydown", onKeyDown);
      trapCleanup = null;
    };
  }

  function teardownInteractionLocks() {
    stopCountdown();
    stopEmergencyPoll();
    trapCleanup?.();
    scrollLockCleanup?.();
  }

  function removeOverlay() {
    teardownInteractionLocks();
    document.getElementById(ROOT_ID)?.remove();
  }

  function updateCountdownEl(valueEl, countdownWrap) {
    if (!blockEndTime) {
      countdownWrap.hidden = true;
      stopCountdown();
      return;
    }
    const remaining = getUnblockRemainingMs(blockEndTime);
    if (remaining <= 0) {
      countdownWrap.hidden = true;
      stopCountdown();
      return;
    }
    countdownWrap.hidden = false;
    valueEl.textContent = formatCountdown(remaining);
  }

  function startCountdown(valueEl, countdownWrap) {
    stopCountdown();
    updateCountdownEl(valueEl, countdownWrap);
    countdownTimer = setInterval(() => updateCountdownEl(valueEl, countdownWrap), 1000);
  }

  function startEmergencyPoll(remainingEl, emergencyBtn) {
    stopEmergencyPoll();

    const update = async () => {
      try {
        const { remainingMs } = await chrome.runtime.sendMessage({
          type: "GET_EMERGENCY_REMAINING",
        });
        const remaining = remainingMs ?? 0;
        remainingEl.textContent = `${formatMsAsMmSs(remaining)} remaining today`;
        emergencyBtn.disabled = remaining <= 0;
      } catch {
        // Extension context may be unavailable.
      }
    };

    update();
    emergencyPollTimer = setInterval(update, 1000);
  }

  function renderOverlay(state) {
    removeOverlay();
    lockPageInteraction();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Site blocked");
    root.tabIndex = -1;

    root.innerHTML = `
      <div class="bw-card">
        <div class="bw-icon" aria-hidden="true">🚫</div>
        <h1 class="bw-title">This site is blocked</h1>
        <p class="bw-message"></p>
        <div class="bw-countdown" hidden>
          <span class="bw-countdown-label">Unblocks in</span>
          <span class="bw-countdown-value">0:00</span>
        </div>
        <div class="bw-emergency">
          <h2>Emergency access</h2>
          <p class="bw-remaining"></p>
          <button type="button" class="bw-btn">Use emergency access</button>
          <p class="bw-hint">Uses your daily cumulative allowance. Time counts while you browse.</p>
        </div>
        <p class="bw-error" hidden></p>
      </div>
    `;

    const messageEl = root.querySelector(".bw-message");
    const countdownWrap = root.querySelector(".bw-countdown");
    const countdownValue = root.querySelector(".bw-countdown-value");
    const remainingEl = root.querySelector(".bw-remaining");
    const emergencyBtn = root.querySelector(".bw-btn");
    const errorEl = root.querySelector(".bw-error");

    messageEl.textContent = state.expired
      ? "Your emergency access time for today has run out."
      : "You started a blocking session. Stay focused.";

    remainingEl.textContent = `${formatMsAsMmSs(state.emergencyRemainingMs)} remaining today`;
    emergencyBtn.disabled = state.emergencyRemainingMs <= 0;

    blockEndTime = state.blockEndTime;
    startCountdown(countdownValue, countdownWrap);
    startEmergencyPoll(remainingEl, emergencyBtn);

    emergencyBtn.addEventListener("click", async () => {
      errorEl.hidden = true;
      errorEl.textContent = "";
      emergencyBtn.disabled = true;

      const result = await chrome.runtime.sendMessage({
        type: "GRANT_EMERGENCY",
        url: location.href,
      });

      if (!result?.ok) {
        errorEl.hidden = false;
        errorEl.textContent = result?.error || "Could not grant emergency access.";
        try {
          const { remainingMs } = await chrome.runtime.sendMessage({
            type: "GET_EMERGENCY_REMAINING",
          });
          emergencyBtn.disabled = (remainingMs ?? 0) <= 0;
        } catch {
          emergencyBtn.disabled = false;
        }
        emergencyBtn.focus();
        return;
      }

      removeOverlay();
    });

    document.documentElement.appendChild(root);
    setupFocusTrap(root, emergencyBtn);
  }

  async function refreshOverlay(expired = false) {
    const state = await chrome.runtime.sendMessage({
      type: "GET_OVERLAY_STATE",
      url: location.href,
      expired,
    });

    if (!state?.show) {
      removeOverlay();
      return;
    }

    renderOverlay({ ...state, expired: expired || state.expired });
  }

  if (!window.__blockwebsiteOverlayListening) {
    window.__blockwebsiteOverlayListening = true;
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "SHOW_OVERLAY") {
        refreshOverlay(message.expired);
      }
      if (message.type === "HIDE_OVERLAY" || message.type === "REMOVE_OVERLAY") {
        removeOverlay();
      }
    });
  }

  refreshOverlay();
})();
