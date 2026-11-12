import type { ScheduleEvent, ScheduleResource } from "@velvetai/contracts";

export interface EventVisualPresentation {
  icon: string;
  statusLine: string;
  serviceLine: string;
  buyerLabel: string;
  tags: string[];
  cls: string;
  expiredLocally: boolean;
}

export interface ScheduleLegendEntry {
  id: string;
  icon: string;
  label: string;
  description: string;
  swatchClass: string;
}

export const SCHEDULE_LEGEND_ITEMS: readonly ScheduleLegendEntry[] = [
  {
    id: "hold",
    icon: "⏳",
    label: "Hold · live countdown",
    description: "Dashed amber border with live 5-minute countdown",
    swatchClass: "legend-swatch--hold",
  },
  {
    id: "awaiting",
    icon: "◔",
    label: "Awaiting deposit",
    description: "Approved booking waiting for PayPal Sandbox payment",
    swatchClass: "legend-swatch--awaiting",
  },
  {
    id: "verifying",
    icon: "⟳",
    label: "Verifying payment",
    description: "Pulsing amber border while payment status reconciles",
    swatchClass: "legend-swatch--verifying",
  },
  {
    id: "paid",
    icon: "●",
    label: "Confirmed · Deposit paid",
    description: "Solid emerald border after PayPal capture completed",
    swatchClass: "legend-swatch--paid",
  },
  {
    id: "checked-in",
    icon: "✓",
    label: "Checked in",
    description: "Solid cobalt highlight when guest has checked in",
    swatchClass: "legend-swatch--checked-in",
  },
  {
    id: "completed",
    icon: "✔",
    label: "Completed",
    description: "Muted appearance for finished appointments",
    swatchClass: "legend-swatch--completed",
  },
  {
    id: "no-show",
    icon: "⚠",
    label: "No-show",
    description: "Faded warning indicator when buyer did not arrive",
    swatchClass: "legend-swatch--no-show",
  },
  {
    id: "cancelled",
    icon: "✕",
    label: "Cancelled",
    description: "Faded bar with strikethrough service text",
    swatchClass: "legend-swatch--cancelled",
  },
  {
    id: "demo",
    icon: "◆",
    label: "Demo booking",
    description: "Dotted underline label indicating seeded demo calendar fixture",
    swatchClass: "legend-swatch--demo",
  },
];

export function formatHoldCountdown(
  holdExpiresAt: string,
  nowMs: number,
): {
  remainingSeconds: number;
  label: string;
} {
  const expiresMs = new Date(holdExpiresAt).getTime();
  if (!Number.isFinite(expiresMs)) {
    return { remainingSeconds: 0, label: "0:00" };
  }
  const diffSec = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return {
    remainingSeconds: diffSec,
    label: `${mins}:${String(secs).padStart(2, "0")}`,
  };
}

function formatDemoFixtureStatus(rawStatus: string): {
  icon: string;
  text: string;
  extraCls: string;
} {
  const upper = rawStatus.toUpperCase();
  switch (upper) {
    case "CHECKED_IN":
      return { icon: "✓", text: "Demo booking · Checked in", extraCls: "velvet-evt--checked-in" };
    case "COMPLETED":
      return { icon: "✔", text: "Demo booking · Completed", extraCls: "velvet-evt--completed" };
    case "NO_SHOW":
      return { icon: "⚠", text: "Demo booking · No-show", extraCls: "velvet-evt--no-show" };
    case "CANCELLED":
      return { icon: "✕", text: "Demo booking · Cancelled", extraCls: "velvet-evt--cancelled" };
    case "CONFIRMED":
    default:
      return { icon: "◆", text: "Demo booking · Confirmed", extraCls: "velvet-evt--paid" };
  }
}

export function buildEventVisual(
  event: Pick<
    ScheduleEvent,
    "kind" | "status" | "paymentState" | "serviceName" | "buyerLabel" | "preparedBy" | "noShowRisk"
  > & { holdExpiresAt?: string; isRaceFlash?: boolean },
  nowMs: number,
): EventVisualPresentation {
  const tags: string[] = [];
  if (event.preparedBy === "ASK_AI") tags.push("via AI");
  else if (event.preparedBy === "MCP") tags.push("via MCP");
  if (event.noShowRisk?.band === "HIGH") tags.push("High no-show risk");

  const flashCls = event.isRaceFlash ? " velvet-evt--race-flash" : "";

  if (event.kind === "HOLD") {
    let statusLine = "Hold";
    let expiredLocally = false;
    if (event.holdExpiresAt) {
      const cd = formatHoldCountdown(event.holdExpiresAt, nowMs);
      expiredLocally = cd.remainingSeconds <= 0;
      statusLine = cd.remainingSeconds > 0 ? `Hold · ${cd.label} left` : "Hold · 0:00 left";
    }
    return {
      icon: "⏳",
      statusLine,
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--hold${flashCls}`,
      expiredLocally,
    };
  }

  if (event.kind === "DEMO_FIXTURE") {
    const fx = formatDemoFixtureStatus(event.status);
    return {
      icon: fx.icon,
      statusLine: fx.text,
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--demo ${fx.extraCls}${flashCls}`,
      expiredLocally: false,
    };
  }

  const upperStatus = event.status.toUpperCase();
  if (upperStatus === "CHECKED_IN") {
    return {
      icon: "✓",
      statusLine: "Checked in",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--checked-in${flashCls}`,
      expiredLocally: false,
    };
  }
  if (upperStatus === "COMPLETED") {
    return {
      icon: "✔",
      statusLine: "Completed",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--completed${flashCls}`,
      expiredLocally: false,
    };
  }
  if (upperStatus === "NO_SHOW") {
    return {
      icon: "⚠",
      statusLine: "No-show",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--no-show${flashCls}`,
      expiredLocally: false,
    };
  }
  if (upperStatus === "CANCELLED") {
    return {
      icon: "✕",
      statusLine: "Cancelled",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--cancelled${flashCls}`,
      expiredLocally: false,
    };
  }
  if (event.paymentState === "VERIFYING" || upperStatus === "CAPTURE_UNCERTAIN") {
    return {
      icon: "⟳",
      statusLine: "Verifying payment",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--verifying${flashCls}`,
      expiredLocally: false,
    };
  }
  if (
    event.paymentState === "AWAITING_PAYER" ||
    upperStatus === "COMMITTING" ||
    upperStatus === "REQUIRES_PAYER_ACTION" ||
    upperStatus === "PAYMENT_PENDING"
  ) {
    return {
      icon: "◔",
      statusLine: "Awaiting deposit",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--awaiting-payer${flashCls}`,
      expiredLocally: false,
    };
  }
  if (event.paymentState === "FAILED" || upperStatus === "PAYMENT_FAILED") {
    return {
      icon: "⚠",
      statusLine: "Payment failed",
      serviceLine: event.serviceName,
      buyerLabel: event.buyerLabel,
      tags,
      cls: `velvet-evt velvet-evt--no-show${flashCls}`,
      expiredLocally: false,
    };
  }

  return {
    icon: "●",
    statusLine:
      event.paymentState === "PARTIALLY_REFUNDED"
        ? "Confirmed · Partial refund"
        : event.paymentState === "REFUNDED"
          ? "Confirmed · Refunded"
          : "Confirmed · Deposit paid",
    serviceLine: event.serviceName,
    buyerLabel: event.buyerLabel,
    tags,
    cls: `velvet-evt velvet-evt--paid${flashCls}`,
    expiredLocally: false,
  };
}

export interface BryntumDomConfigNode {
  tag?: string;
  className?: string;
  text?: string;
  children?: BryntumDomConfigNode[];
}

/**
 * Builds declarative DomConfig nodes (text-only; zero raw HTML string concatenation).
 */
export function buildBryntumEventDomConfig(
  visual: EventVisualPresentation,
): BryntumDomConfigNode[] {
  const line1Children: BryntumDomConfigNode[] = [
    { tag: "span", className: "velvet-evt-icon", text: visual.icon },
    { tag: "span", className: "velvet-evt-status", text: visual.statusLine },
  ];

  for (const tag of visual.tags) {
    line1Children.push({ tag: "span", className: "velvet-evt-tag", text: tag });
  }

  return [
    {
      tag: "div",
      className: "velvet-evt-content",
      children: [
        {
          tag: "div",
          className: "velvet-evt-line1",
          children: line1Children,
        },
        {
          tag: "div",
          className: "velvet-evt-line2",
          text: `${visual.serviceLine} · ${visual.buyerLabel}`,
        },
      ],
    },
  ];
}

export function getDateKeyInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDaysToDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split("-").map((n) => parseInt(n, 10));
  const next = new Date(Date.UTC(y!, m! - 1, d! + deltaDays));
  return next.toISOString().slice(0, 10);
}

export function getUtcForZoneWallClock(dateKey: string, timeStr: string, timeZone: string): Date {
  const guess = new Date(`${dateKey}T${timeStr}Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  let offsetMs = 0;
  for (let i = 0; i < 3; i++) {
    const current = new Date(guess.getTime() - offsetMs);
    const parts = formatter.formatToParts(current);
    const p = Object.fromEntries(parts.map((pt) => [pt.type, pt.value]));
    const formattedIso = `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`;
    const localParsed = new Date(formattedIso);
    const diff = localParsed.getTime() - guess.getTime();
    if (diff === 0) {
      return current;
    }
    offsetMs += diff;
  }
  return new Date(guess.getTime() - offsetMs);
}

export function formatMerchantDayLabel(dateKey: string, timeZone: string): string {
  const noonUtc = getUtcForZoneWallClock(dateKey, "12:00:00", timeZone);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZoneName: "short",
  }).format(noonUtc);
}

export function buildNewBookingAnnouncement(
  prevEventIds: ReadonlySet<string>,
  nextEvents: readonly ScheduleEvent[],
  resources: readonly ScheduleResource[],
): string | null {
  const resourceMap = new Map(resources.map((r) => [r.id, r.name]));
  const added = nextEvents.filter(
    (evt) => evt.kind !== "DEMO_FIXTURE" && !prevEventIds.has(evt.id),
  );
  if (added.length === 0) {
    return null;
  }
  const latest = added[0]!;
  const providerName = resourceMap.get(latest.resourceId) || "provider";
  const prefix = latest.kind === "HOLD" ? "New hold" : "New booking";
  const msg = `${prefix}: ${latest.serviceName}, ${latest.display.localStart} ${latest.display.timeZoneLabel}, ${providerName}.`;
  return added.length > 1 ? `${msg} (${added.length} new updates)` : msg;
}

/**
 * Picks a future open 1-hour slot for the interactive race-test demo on the judge schedule.
 */
export function pickOpenRaceSlot(input: {
  events: readonly ScheduleEvent[];
  resources: readonly ScheduleResource[];
  dateKey: string;
  timeZone: string;
  nowMs?: number;
}): { resourceId?: string; startsAt: string } {
  const nowMs = input.nowMs ?? Date.now();
  const minFutureMs = nowMs + 15 * 60_000;
  const candidateDayKeys = [
    input.dateKey,
    addDaysToDateKey(input.dateKey, 1),
    addDaysToDateKey(getDateKeyInZone(new Date(nowMs), input.timeZone), 1),
  ];

  const primaryResourceId = input.resources[0]?.id;

  for (const dayKey of candidateDayKeys) {
    for (let hour = 9; hour <= 18; hour++) {
      const timeStr = `${String(hour).padStart(2, "0")}:00:00`;
      const start = getUtcForZoneWallClock(dayKey, timeStr, input.timeZone);
      const startMs = start.getTime();
      if (startMs <= minFutureMs) continue;
      const endMs = startMs + 60 * 60_000;

      if (!primaryResourceId) {
        return { startsAt: start.toISOString() };
      }

      const overlaps = input.events.some((evt) => {
        if (evt.resourceId !== primaryResourceId) return false;
        if (evt.status === "CANCELLED") return false;
        const evtStart = new Date(evt.startsAt).getTime();
        const evtEnd = new Date(evt.endsAt).getTime();
        return evtStart < endMs && evtEnd > startMs;
      });

      if (!overlaps) {
        return { resourceId: primaryResourceId, startsAt: start.toISOString() };
      }
    }
  }

  const fallbackDay = addDaysToDateKey(getDateKeyInZone(new Date(nowMs), input.timeZone), 2);
  const fallbackStart = getUtcForZoneWallClock(fallbackDay, "11:00:00", input.timeZone);
  return {
    ...(primaryResourceId ? { resourceId: primaryResourceId } : {}),
    startsAt: fallbackStart.toISOString(),
  };
}
