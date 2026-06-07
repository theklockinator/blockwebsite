import {
  extractHostname,
  normalizeTargetUrl,
  patternToUrlRegex,
  urlMatchesAnyPattern,
} from "./lib/patterns.js";
import {
  getEmergencyRemainingMs,
  getSettings,
  recordEmergencyUsage,
  saveSettings,
} from "./lib/storage.js";

const OVERLAY_SCRIPT_ID = "blockwebsite-overlay";
const BLOCKING_TICK_ALARM = "blocking-tick";
const BLOCK_END_ALARM = "block-end";
const EMERGENCY_ALARM_PREFIX = "emergency-tab-";

function emergencyAlarmName(tabId) {
  return `${EMERGENCY_ALARM_PREFIX}${tabId}`;
}

/** @type {Map<number, { host: string, startedAt: number, endsAt: number }>} */
const activeEmergencyTabs = new Map();

let syncPaused = false;
let syncPromise = null;

function parseBlockEndMs(blockEndTime) {
  return new Date(blockEndTime).getTime();
}

function isInjectableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function getOverlayState(url, tabId, expired = false) {
  const settings = await ensureBlockingNotExpired();
  const normalizedUrl = normalizeTargetUrl(url);

  const base = {
    show: false,
    emergencyRemainingMs: getEmergencyRemainingMs(settings, activeEmergencyTabs),
    blockEndTime: settings.blockEndTime,
    expired,
  };

  if (!settings.blockingActive || !normalizedUrl) return base;
  if (activeEmergencyTabs.has(tabId)) return base;
  if (!urlMatchesAnyPattern(normalizedUrl, settings.patterns)) return base;

  return { ...base, show: true };
}

async function registerOverlayScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_SCRIPT_ID] });
  } catch {
    // Not registered yet.
  }

  await chrome.scripting.registerContentScripts([
    {
      id: OVERLAY_SCRIPT_ID,
      matches: ["http://*/*", "https://*/*"],
      js: ["content/overlay.js"],
      css: ["content/overlay.css"],
      runAt: "document_idle",
    },
  ]);
}

async function unregisterOverlayScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_SCRIPT_ID] });
  } catch {
    // Already unregistered.
  }
  await removeOverlaysFromAllTabs();
}

async function sendOverlayMessage(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

async function injectOverlay(tabId, expired = false) {
  const shown = await sendOverlayMessage(tabId, {
    type: "SHOW_OVERLAY",
    expired,
  });
  if (shown) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/overlay.js"],
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content/overlay.css"],
  });
  await sendOverlayMessage(tabId, { type: "SHOW_OVERLAY", expired });
}

async function hideOverlay(tabId) {
  await sendOverlayMessage(tabId, { type: "HIDE_OVERLAY" });
}

async function maybeOverlayTab(tabId, url, expired = false) {
  if (!isInjectableUrl(url)) {
    await hideOverlay(tabId);
    return;
  }

  const state = await getOverlayState(url, tabId, expired);
  if (state.show) {
    await injectOverlay(tabId, expired);
  } else {
    await hideOverlay(tabId);
  }
}

async function applyOverlaysToAllTabs(expiredTabId = null) {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    await maybeOverlayTab(tab.id, tab.url, tab.id === expiredTabId);
  }
}

async function removeOverlaysFromAllTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (tab.id) await sendOverlayMessage(tab.id, { type: "REMOVE_OVERLAY" });
  }
}

async function ensureBlockingNotExpired() {
  const settings = await getSettings();
  if (!settings.blockingActive) return settings;

  if (!settings.blockEndTime) {
    await stopBlocking();
    return getSettings();
  }

  const end = parseBlockEndMs(settings.blockEndTime);
  if (!Number.isFinite(end) || end <= Date.now()) {
    await stopBlocking();
    return getSettings();
  }
  return settings;
}

function scheduleBlockingTick() {
  chrome.alarms.create(BLOCKING_TICK_ALARM, { periodInMinutes: 1 });
}

async function scheduleBlockEndAlarm(blockEndTime) {
  chrome.alarms.clear(BLOCK_END_ALARM);
  if (!blockEndTime) return;

  const when = new Date(blockEndTime).getTime();
  if (!Number.isFinite(when) || when <= Date.now()) {
    await stopBlocking();
    return;
  }
  chrome.alarms.create(BLOCK_END_ALARM, { when });
}

async function stopBlocking() {
  for (const tabId of activeEmergencyTabs.keys()) {
    await chrome.alarms.clear(emergencyAlarmName(tabId));
  }
  activeEmergencyTabs.clear();
  await chrome.alarms.clear(BLOCKING_TICK_ALARM);
  await chrome.alarms.clear(BLOCK_END_ALARM);
  await saveSettings({ blockingActive: false });
  await unregisterOverlayScript();
}

async function runSyncFromSettings() {
  const settings = await ensureBlockingNotExpired();

  if (settings.blockingActive && settings.blockEndTime) {
    await scheduleBlockEndAlarm(settings.blockEndTime);
  }

  if (settings.blockingActive) {
    await registerOverlayScript();
    await applyOverlaysToAllTabs();
    scheduleBlockingTick();
  } else {
    await unregisterOverlayScript();
  }
}

function syncFromSettings() {
  if (syncPromise) return syncPromise;
  syncPromise = runSyncFromSettings().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

async function endEmergencyForTab(tabId, recordMs = true) {
  const session = activeEmergencyTabs.get(tabId);
  if (!session) return;

  activeEmergencyTabs.delete(tabId);
  await chrome.alarms.clear(emergencyAlarmName(tabId));

  if (recordMs) {
    const elapsed = Math.min(Date.now() - session.startedAt, session.endsAt - session.startedAt);
    if (elapsed > 0) await recordEmergencyUsage(elapsed);
  }
}

async function expireEmergencySession(tabId, expired = true) {
  const session = activeEmergencyTabs.get(tabId);
  if (!session) return;

  const used = Math.min(Date.now() - session.startedAt, session.endsAt - session.startedAt);
  activeEmergencyTabs.delete(tabId);
  await chrome.alarms.clear(emergencyAlarmName(tabId));

  if (used > 0) await recordEmergencyUsage(used);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      await maybeOverlayTab(tabId, tab.url, expired);
    }
  } catch {
    // Tab may have closed.
  }
}

function scheduleEmergencyAlarm(tabId, endsAt) {
  chrome.alarms.create(emergencyAlarmName(tabId), { when: endsAt });
}

async function grantEmergencyAccess(tabId, targetUrl) {
  const settings = await ensureBlockingNotExpired();
  if (!settings.blockingActive) return { ok: false, error: "Blocking is not active." };

  const remaining = getEmergencyRemainingMs(settings, activeEmergencyTabs);
  if (remaining <= 0) {
    return { ok: false, error: "No emergency time left today." };
  }

  const normalizedUrl = normalizeTargetUrl(targetUrl);
  if (!normalizedUrl || !urlMatchesAnyPattern(normalizedUrl, settings.patterns)) {
    return { ok: false, error: "URL is not on the block list." };
  }

  const host = extractHostname(normalizedUrl);
  if (!host) {
    return { ok: false, error: "URL is not on the block list." };
  }

  if (activeEmergencyTabs.has(tabId)) {
    await endEmergencyForTab(tabId, false);
  }

  const endsAt = Date.now() + remaining;
  activeEmergencyTabs.set(tabId, { host, startedAt: Date.now(), endsAt });

  scheduleEmergencyAlarm(tabId, endsAt);
  scheduleBlockingTick();
  await hideOverlay(tabId);

  return { ok: true, remainingMs: remaining };
}

async function tickEmergencySessions() {
  const now = Date.now();
  for (const [tabId, session] of [...activeEmergencyTabs.entries()]) {
    if (now >= session.endsAt) {
      await expireEmergencySession(tabId, true);
    }
  }
}

async function onBlockingTick() {
  const settings = await ensureBlockingNotExpired();
  if (!settings.blockingActive) {
    await chrome.alarms.clear(BLOCKING_TICK_ALARM);
    return;
  }
  await tickEmergencySessions();
}

async function handleNavigation(tabId, url) {
  const settings = await getSettings();
  if (!settings.blockingActive || !isInjectableUrl(url)) return;
  await maybeOverlayTab(tabId, url);
}

chrome.runtime.onInstalled.addListener(() => syncFromSettings());
chrome.runtime.onStartup.addListener(() => syncFromSettings());
ensureBlockingNotExpired().then(syncFromSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && !syncPaused) syncFromSettings();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BLOCK_END_ALARM) {
    await stopBlocking();
    return;
  }
  if (alarm.name.startsWith(EMERGENCY_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(EMERGENCY_ALARM_PREFIX.length));
    if (Number.isFinite(tabId)) {
      await expireEmergencySession(tabId, true);
    }
    return;
  }
  if (alarm.name === BLOCKING_TICK_ALARM) {
    await onBlockingTick();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  endEmergencyForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
    if (changeInfo.url) {
      if (activeEmergencyTabs.has(tabId)) {
        const session = activeEmergencyTabs.get(tabId);
        const host = extractHostname(changeInfo.url);
        if (!host || host !== session.host) {
          await endEmergencyForTab(tabId);
        }
      }
      await handleNavigation(tabId, changeInfo.url);
    } else if (changeInfo.status === "complete" && tab.url) {
      await handleNavigation(tabId, tab.url);
    }
  })();
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  handleNavigation(details.tabId, details.url);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tabId = message.tabId ?? sender.tab?.id;

    switch (message.type) {
      case "GET_STATUS": {
        const settings = await ensureBlockingNotExpired();
        sendResponse({
          ...settings,
          emergencyRemainingMs: getEmergencyRemainingMs(settings, activeEmergencyTabs),
          activeEmergencyTabs: activeEmergencyTabs.size,
        });
        break;
      }
      case "GET_OVERLAY_STATE": {
        sendResponse(await getOverlayState(message.url, tabId, message.expired));
        break;
      }
      case "START_BLOCKING": {
        const { blockEndTime, patterns, emergencyAllowanceMs } = message;
        const end = new Date(blockEndTime).getTime();
        if (!Number.isFinite(end) || end <= Date.now()) {
          sendResponse({ ok: false, error: "Stop time must be in the future." });
          break;
        }
        if (!patterns?.length) {
          sendResponse({ ok: false, error: "Add at least one pattern." });
          break;
        }
        if (!Number.isFinite(emergencyAllowanceMs) || emergencyAllowanceMs <= 0) {
          sendResponse({ ok: false, error: "Set a valid emergency time." });
          break;
        }
        if (patterns.some((pattern) => !patternToUrlRegex(pattern))) {
          sendResponse({ ok: false, error: "One or more patterns are invalid." });
          break;
        }

        const pendingSettings = {
          blockingActive: true,
          blockEndTime,
          patterns,
          emergencyAllowanceMs,
        };

        syncPaused = true;
        try {
          await saveSettings(pendingSettings);
          await registerOverlayScript();
          await applyOverlaysToAllTabs();
          chrome.alarms.clear(BLOCK_END_ALARM);
          chrome.alarms.create(BLOCK_END_ALARM, { when: end });
          scheduleBlockingTick();
          sendResponse({ ok: true });
        } catch (err) {
          await unregisterOverlayScript();
          await saveSettings({ blockingActive: false });
          sendResponse({
            ok: false,
            error: err?.message || "Could not start blocking.",
          });
        } finally {
          syncPaused = false;
        }
        break;
      }
      case "UPDATE_PATTERNS": {
        syncPaused = true;
        try {
          await saveSettings({ patterns: message.patterns });
          await syncFromSettings();
          sendResponse({ ok: true });
        } finally {
          syncPaused = false;
        }
        break;
      }
      case "GRANT_EMERGENCY": {
        const result = await grantEmergencyAccess(tabId, message.url);
        sendResponse(result);
        break;
      }
      case "GET_EMERGENCY_REMAINING": {
        const settings = await ensureBlockingNotExpired();
        sendResponse({
          remainingMs: getEmergencyRemainingMs(settings, activeEmergencyTabs),
        });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();
  return true;
});
