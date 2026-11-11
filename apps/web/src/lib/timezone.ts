/**
 * Resolves a human-readable time zone abbreviation (e.g. "IST" instead of "GMT+5:30")
 * for a given Date and IANA time zone.
 */
export function getReadableZoneLabel(date: Date, timeZone?: string): string {
  try {
    const shortFormatter = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      timeZoneName: "short",
    });
    const parts = shortFormatter.formatToParts(date);
    const shortName = parts.find((p) => p.type === "timeZoneName")?.value || "";
    if (shortName && !/^GMT[+-]/i.test(shortName) && !/^UTC[+-]/i.test(shortName)) {
      return shortName;
    }
    if (timeZone === "Asia/Kolkata" || timeZone === "Asia/Calcutta") {
      return "IST";
    }
    const longFormatter = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      timeZoneName: "longGeneric",
    });
    const longParts = longFormatter.formatToParts(date);
    return longParts.find((p) => p.type === "timeZoneName")?.value || shortName;
  } catch {
    return "";
  }
}

/**
 * Formats a single instant in the user's browser time zone when it differs from the merchant zone.
 */
export function formatUserLocalSlot(startsAt?: string, merchantTimeZone?: string): string | null {
  if (!startsAt) return null;
  try {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (merchantTimeZone && browserZone.toLowerCase() === merchantTimeZone.toLowerCase()) {
      return null;
    }
    const date = new Date(startsAt);
    if (isNaN(date.getTime())) return null;

    const timeStr = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(browserZone ? { timeZone: browserZone } : {}),
    }).format(date);

    const zoneStr = getReadableZoneLabel(date, browserZone);
    return zoneStr ? `${timeStr} ${zoneStr}` : timeStr;
  } catch {
    return null;
  }
}

/**
 * Formats a start–end appointment window in the user's browser time zone (with readable zone name)
 * when the browser zone differs from the merchant zone.
 */
export function formatUserLocalWindow(
  startsAt: string,
  endsAt: string,
  merchantTimeZone?: string,
): string | null {
  try {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserZone) return null;
    if (merchantTimeZone && browserZone.toLowerCase() === merchantTimeZone.toLowerCase()) {
      return null;
    }

    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return null;
    }

    const bDate = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: browserZone,
    }).format(startDate);

    const bStart = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: browserZone,
    }).format(startDate);

    const bEnd = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: browserZone,
    }).format(endDate);

    const zoneLabel = getReadableZoneLabel(endDate, browserZone);
    return `Your time: ${bDate}, ${bStart} – ${bEnd}${zoneLabel ? ` ${zoneLabel}` : ""}`;
  } catch {
    return null;
  }
}
