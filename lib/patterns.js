const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

/**
 * Convert one dot-separated segment, where * is a wildcard within the segment.
 * e.g. "*google" → [^.]*google, "mail*" → mail[^.]*
 */
function segmentToRegex(segment) {
  if (segment === "*") return "[^.]*";

  return segment
    .split("*")
    .map((part) => part.replace(REGEX_SPECIALS, "\\$&"))
    .join("[^.]*");
}

function patternToHostRegex(pattern) {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return null;

  const segments = trimmed.split(".");
  if (segments.some((seg) => seg === "")) return null;

  return segments.map(segmentToRegex).join("\\.");
}

/**
 * Convert a user pattern like "*.google.*" or "*google.*" into a RegExp
 * tested against hostnames. * is a wildcard within each dot-separated segment.
 */
export function patternToRegex(pattern) {
  const hostPattern = patternToHostRegex(pattern);
  if (!hostPattern) return null;
  return new RegExp(`^${hostPattern}$`, "i");
}

export function hostnameMatchesPattern(hostname, pattern) {
  const regex = patternToRegex(pattern);
  if (!regex) return false;
  return regex.test(hostname.toLowerCase());
}

export function hostnameMatchesAnyPattern(hostname, patterns) {
  return patterns.some((p) => hostnameMatchesPattern(hostname, p));
}

/**
 * Build a DNR regexFilter (RE2) for full URLs from a hostname-oriented pattern.
 */
export function patternToUrlRegex(pattern) {
  const hostPattern = patternToHostRegex(pattern);
  if (!hostPattern) return null;

  // DNR redirect with regexSubstitution requires at least one capturing group.
  return `(^https?://(?:[^@/]*@)?(?:[^:/?#]*\\.)*${hostPattern}(/|:|$|\\?))`;
}

export function extractHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isValidPattern(pattern) {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed.includes("://")) return false;
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return false;
  return patternToHostRegex(trimmed) !== null;
}
