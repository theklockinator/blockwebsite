import {
  extractHostname,
  hostnameMatchesAnyPattern,
  patternToUrlRegex,
} from "./lib/patterns.js";
import {
  getEmergencyRemainingMs,
  getSettings,
  recordEmergencyUsage,
  saveSettings,
} from "./lib/storage.js";

const BLOCK_RULE_BASE = 1000;
const ALLOW_RULE_BASE = 2000;
const BLOCKING_TICK_ALARM = "blocking-tick";
const BLOCK_END_ALARM = "block-end";

/** @type {Map<number, { host: string, startedAt: number, endsAt: number }>} */
const activeEmergencyTabs = new Map();

let syncPaused = false;
let syncPromise = null;
/** @type {Promise<void>} */
let dnrChain = Promise.resolve();

function withDnrLock(task) {
  const run = dnrChain.then(task);
  dnrChain = run.catch(() => {});
  return run;
}

async function getBlockRuleIds() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules
    .filter((r) => r.id >= BLOCK_RULE_BASE && r.id < ALLOW_RULE_BASE)
    .map((r) => r.id);
}

async function updateDynamicRulesLocked(options) {
  return withDnrLock(() => chrome.declarativeNetRequest.updateDynamicRules(options));
}

async function removeBlockRules() {
  await withDnrLock(async () => {
    const blockIds = await getBlockRuleIds();
    if (blockIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: blockIds });
    }
  });
}

async function clearAllDynamicRules() {
  await withDnrLock(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = rules.map((r) => r.id);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    }
  });
}

function buildBlockRules(settings) {
  const blockedPageUrl = chrome.runtime.getURL("blocked/blocked.html");
  return settings.patterns
    .map((pattern, index) => {
      const regexFilter = patternToUrlRegex(pattern);
      if (!regexFilter) return null;
      return {
        id: BLOCK_RULE_BASE + index,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: `${blockedPageUrl}?url=\\1&pattern=${encodeURIComponent(pattern)}`,
          },
        },
        condition: {
          regexFilter,
          resourceTypes: ["main_frame"],
        },
      };
    })
    .filter(Boolean);
}

async function replaceBlockRules(settings) {
  const rules = buildBlockRules(settings);
  if (!rules.length) {
    throw new Error("No valid block rules could be created.");
  }

  await withDnrLock(async () => {
    const removeRuleIds = await getBlockRuleIds();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  });
}

async function updateBlockRules(settings) {
  if (settings.blockingActive) {
    if (!settings.blockEndTime) {
      await stopBlocking();
      return;
    }
    const end = parseBlockEndMs(settings.blockEndTime);
    if (!Number.isFinite(end) || end <= Date.now()) {
      await stopBlocking();
      return;
    }
  }

  if (!settings.blockingActive || !settings.patterns.length) {
    await removeBlockRules();
    return;
  }

  try {
    await replaceBlockRules(settings);
  } catch (err) {
    console.error("Failed to install block rules:", err);
    await stopBlocking();
    throw err;
  }
}

function hostToUrlRegex(host) {
  const escaped = host.replace(/\./g, "\\.");
  return `^https?://(?:[^@/]+@)?(?:[^/:?#]+\\.)*${escaped}(/|$|\\?)`;
}

async function addAllowRule(host, ruleId) {
  await updateDynamicRulesLocked({
    addRules: [
      {
        id: ruleId,
        priority: 10,
        action: { type: "allow" },
        condition: {
          regexFilter: hostToUrlRegex(host),
          resourceTypes: ["main_frame"],
        },
      },
    ],
  });
}

async function removeAllowRule(ruleId) {
  try {
    await updateDynamicRulesLocked({ removeRuleIds: [ruleId] });
  } catch {
    // Rule may already be gone.
  }
}

function parseBlockEndMs(blockEndTime) {
  return new Date(blockEndTime).getTime();
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
  activeEmergencyTabs.clear();
  await chrome.alarms.clear(BLOCKING_TICK_ALARM);
  await chrome.alarms.clear(BLOCK_END_ALARM);
  await saveSettings({ blockingActive: false });
  await clearAllDynamicRules();
}

async function runSyncFromSettings() {
  const settings = await ensureBlockingNotExpired();

  if (settings.blockingActive && settings.blockEndTime) {
    await scheduleBlockEndAlarm(settings.blockEndTime);
  }

  if (settings.blockingActive) {
    await updateBlockRules(settings);
    scheduleBlockingTick();
  } else {
    await clearAllDynamicRules();
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
  await removeAllowRule(ALLOW_RULE_BASE + tabId);

  if (recordMs) {
    const elapsed = Math.min(Date.now() - session.startedAt, session.endsAt - session.startedAt);
    if (elapsed > 0) await recordEmergencyUsage(elapsed);
  }
}

async function grantEmergencyAccess(tabId, targetUrl) {
  const settings = await ensureBlockingNotExpired();
  if (!settings.blockingActive) return { ok: false, error: "Blocking is not active." };

  const remaining = getEmergencyRemainingMs(settings);
  if (remaining <= 0) {
    return { ok: false, error: "No emergency time left today." };
  }

  const host = extractHostname(targetUrl);
  if (!host || !hostnameMatchesAnyPattern(host, settings.patterns)) {
    return { ok: false, error: "URL is not on the block list." };
  }

  if (activeEmergencyTabs.has(tabId)) {
    await endEmergencyForTab(tabId, false);
  }

  const ruleId = ALLOW_RULE_BASE + tabId;
  await addAllowRule(host, ruleId);

  const endsAt = Date.now() + remaining;
  activeEmergencyTabs.set(tabId, { host, startedAt: Date.now(), endsAt });

  scheduleBlockingTick();
  await chrome.tabs.update(tabId, { url: targetUrl });

  return { ok: true, remainingMs: remaining };
}

async function tickEmergencySessions() {
  const now = Date.now();
  for (const [tabId, session] of activeEmergencyTabs.entries()) {
    if (now >= session.endsAt) {
      const used = session.endsAt - session.startedAt;
      await recordEmergencyUsage(used);
      await removeAllowRule(ALLOW_RULE_BASE + tabId);
      activeEmergencyTabs.delete(tabId);

      const blockedPage = chrome.runtime.getURL(
        `blocked/blocked.html?url=${encodeURIComponent(`https://${session.host}/`)}&expired=1`
      );
      try {
        await chrome.tabs.update(tabId, { url: blockedPage });
      } catch {
        // Tab may have closed.
      }
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

chrome.runtime.onInstalled.addListener(() => syncFromSettings());
chrome.runtime.onStartup.addListener(() => syncFromSettings());

// Service worker can wake at any time — always reconcile expired blocking.
ensureBlockingNotExpired().then(syncFromSettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && !syncPaused) syncFromSettings();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BLOCK_END_ALARM) {
    await stopBlocking();
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
  if (!activeEmergencyTabs.has(tabId)) return;
  if (changeInfo.url) {
    const session = activeEmergencyTabs.get(tabId);
    const host = extractHostname(changeInfo.url);
    if (!host || host !== session.host) {
      endEmergencyForTab(tabId);
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_STATUS": {
        const settings = await ensureBlockingNotExpired();
        sendResponse({
          ...settings,
          emergencyRemainingMs: getEmergencyRemainingMs(settings),
          activeEmergencyTabs: activeEmergencyTabs.size,
        });
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
          await replaceBlockRules(pendingSettings);
          await saveSettings(pendingSettings);
          chrome.alarms.clear(BLOCK_END_ALARM);
          chrome.alarms.create(BLOCK_END_ALARM, { when: end });
          scheduleBlockingTick();
          sendResponse({ ok: true });
        } catch (err) {
          await removeBlockRules();
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
        const tabId = message.tabId ?? _sender.tab?.id;
        const result = await grantEmergencyAccess(tabId, message.url);
        sendResponse(result);
        break;
      }
      case "GET_EMERGENCY_REMAINING": {
        const settings = await ensureBlockingNotExpired();
        sendResponse({ remainingMs: getEmergencyRemainingMs(settings) });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();
  return true;
});
