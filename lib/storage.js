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

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function getEmergencyRemainingMs(settings) {
  const allowanceMs = settings.emergencyAllowanceMs ?? 0;
  const used = settings.emergencyUsedByDate[todayKey()] || 0;
  return Math.max(0, allowanceMs - used);
}

export async function recordEmergencyUsage(ms) {
  const settings = await getSettings();
  const key = todayKey();
  const used = settings.emergencyUsedByDate[key] || 0;
  return saveSettings({
    emergencyUsedByDate: {
      ...settings.emergencyUsedByDate,
      [key]: used + ms,
    },
  });
}
