const MAX_EMERGENCY_MS = 24 * 60 * 60 * 1000;

/**
 * Format milliseconds as M:SS or MM:SS (seconds always two digits).
 */
export function formatMsAsMmSs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function getUnblockRemainingMs(blockEndTime) {
  const end = new Date(blockEndTime).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, end - Date.now());
}

/**
 * Live countdown until unblock: "2d 04:15:32", "4:15:32", or "15:32".
 */
export function formatCountdown(ms) {
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

/**
 * Parse emergency time input:
 * - "5:30" / "15:00" → minutes:seconds
 * - "5.5" / "15" → decimal or whole minutes
 */
export function parseEmergencyTimeInput(raw) {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Enter a time like 15:00 or 5.5." };

  let ms;

  if (value.includes(":")) {
    const parts = value.split(":");
    if (parts.length !== 2) {
      return { ok: false, error: "Use MM:SS or M:SS (e.g. 15:00)." };
    }

    const minutesPart = parts[0].trim();
    const secondsPart = parts[1].trim();
    if (!/^\d+$/.test(minutesPart) || !/^\d{1,2}$/.test(secondsPart)) {
      return { ok: false, error: "Use MM:SS or M:SS (e.g. 15:00)." };
    }

    const minutes = Number(minutesPart);
    const seconds = Number(secondsPart);
    if (seconds > 59) {
      return { ok: false, error: "Seconds must be 00–59." };
    }

    ms = (minutes * 60 + seconds) * 1000;
  } else if (/^\d+(\.\d+)?$/.test(value)) {
    ms = Number(value) * 60 * 1000;
  } else {
    return { ok: false, error: "Use MM:SS, M:SS, or decimal minutes (e.g. 5.5)." };
  }

  if (!Number.isFinite(ms) || ms <= 0) {
    return { ok: false, error: "Time must be greater than zero." };
  }
  if (ms > MAX_EMERGENCY_MS) {
    return { ok: false, error: "Maximum emergency time is 24:00." };
  }

  return { ok: true, ms };
}

export { MAX_EMERGENCY_MS };
