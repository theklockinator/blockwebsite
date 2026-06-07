const DEFAULTS = {
  patterns: [],
  emergencyAllowanceMs: 15 * 60 * 1000,
  blockingActive: false,
  blockEndTime: null,
  emergencyUsedByDate: {},
};

export async function getSettings() {
  const keys = [...Object.keys(DEFAULTS), "emergencyMinutesPerDay"];
  const data = await chrome.storage.local.get(keys);
  const settings = { ...DEFAULTS, ...data };

  if (data.emergencyAllowanceMs == null && data.emergencyMinutesPerDay != null) {
    settings.emergencyAllowanceMs = data.emergencyMinutesPerDay * 60 * 1000;
  }

  return settings;
}

export async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
  return getSettings();
}

/** Local calendar date (YYYY-MM-DD) for daily emergency allowance reset. */
export function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function inFlightEmergencyMs(activeSessions, now = Date.now()) {
  if (!activeSessions?.size) return 0;
  let total = 0;
  for (const session of activeSessions.values()) {
    total += Math.min(now - session.startedAt, session.endsAt - session.startedAt);
  }
  return total;
}

export function getEmergencyRemainingMs(settings, activeSessions = null) {
  const allowanceMs = settings.emergencyAllowanceMs ?? 0;
  const used = settings.emergencyUsedByDate[todayKey()] || 0;
  const inFlight = inFlightEmergencyMs(activeSessions);
  return Math.max(0, allowanceMs - used - inFlight);
}

export async function recordEmergencyUsage(ms) {
  const settings = await getSettings();
  const key = todayKey();
  const used = settings.emergencyUsedByDate[key] || 0;
  return saveSettings({
    emergencyUsedByDate: {
      ...settings.emergencyUsedByDate,
      [key]: used + Math.max(0, Math.round(ms)),
    },
  });
}
