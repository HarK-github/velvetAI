import crypto from "node:crypto";
import { JUDGE_TENANT_ID, JUDGE_SEED_VERSION, JUDGE_NAMESPACE } from "@velvetai/domain";

export interface SeedResource {
  id: string;
  name: string;
  resourceType: string;
}

export interface SeedService {
  id: string;
  versionId: string;
  name: string;
  description: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMinor: string;
  depositMinor: string;
  currency: string;
  resourceIds: string[];
}

export interface SeedSyntheticHistory {
  id: string;
  resourceId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  outcome: "ATTENDED" | "NO_SHOW" | "CANCELLED_LATE" | "CANCELLED_EARLY";
  leadTimeHours: number;
  depositPaid: boolean;
  buyerKey: string;
}

export interface SeedFixture {
  id: string;
  resourceId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  displayStatus: "CONFIRMED" | "CHECKED_IN" | "COMPLETED" | "NO_SHOW" | "CANCELLED";
  buyerKey: string;
  depositPaid: boolean;
}

export interface JudgeSeedPlan {
  seedVersion: string;
  timeZone: string;
  merchant: {
    id: string;
    tenantId: string;
    name: string;
    locationId: string;
    locationName: string;
  };
  resources: SeedResource[];
  services: SeedService[];
  history: SeedSyntheticHistory[];
  fixtures: SeedFixture[];
}

export function deterministicUuid(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(nsBytes).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // Version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createMulberry32(seedStr: string): () => number {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  }
  let a = h >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns year, month, date, and day of week in the target IANA timezone.
 */
function getLocalDateParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(date);
  const findVal = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = parseInt(findVal("year"), 10);
  const month = parseInt(findVal("month"), 10);
  const day = parseInt(findVal("day"), 10);
  const weekday = findVal("weekday"); // "Mon", "Tue", etc.
  return { year, month, day, weekday };
}

/**
 * Constructs a UTC Date corresponding to a specific local year, month, date, hour, minute in an IANA timeZone.
 */
function createDateInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
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
  const parts = formatter.formatToParts(guess);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const localInUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  const offset = localInUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

export function buildJudgeSeedPlan(input: {
  now: Date;
  timeZone: string;
  seed: string;
}): JudgeSeedPlan {
  const { now, timeZone, seed } = input;
  const prng = createMulberry32(`${seed}:${now.toISOString().slice(0, 10)}:${timeZone}`);

  // 1. Merchant & Location
  const locationId = deterministicUuid(JUDGE_NAMESPACE, "location:manhattan-flagship");
  const merchantId = deterministicUuid(JUDGE_NAMESPACE, "merchant:velvet-studio");

  // 2. 4 Resources
  const resources: SeedResource[] = [
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "resource:aria-stylist"),
      name: "Aria (Stylist)",
      resourceType: "CHAIR",
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "resource:marco-barber"),
      name: "Marco (Barber)",
      resourceType: "CHAIR",
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "resource:lena-therapist"),
      name: "Lena (Therapist)",
      resourceType: "ROOM",
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "resource:studio-a-room"),
      name: "Studio A (Room)",
      resourceType: "ROOM",
    },
  ];

  const [aria, marco, lena, studioA] = resources as [
    SeedResource,
    SeedResource,
    SeedResource,
    SeedResource,
  ];

  // 3. 5 Services
  const services: SeedService[] = [
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "service:haircut-beard"),
      versionId: deterministicUuid(JUDGE_NAMESPACE, "service-ver:haircut-beard-v1"),
      name: "Executive Haircut & Beard Sculpt",
      description:
        "Signature tailored haircut with precision hot towel beard contouring and styling.",
      durationMinutes: 45,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      priceMinor: "7500",
      depositMinor: "2000",
      currency: "USD",
      resourceIds: [marco.id, aria.id],
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "service:deep-tissue"),
      versionId: deterministicUuid(JUDGE_NAMESPACE, "service-ver:deep-tissue-v1"),
      name: "Deep Tissue & Mobility Session",
      description:
        "Targeted therapeutic deep tissue work focused on joint decompression and recovery.",
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      priceMinor: "12000",
      depositMinor: "3500",
      currency: "USD",
      resourceIds: [lena.id],
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "service:acoustic-studio"),
      versionId: deterministicUuid(JUDGE_NAMESPACE, "service-ver:acoustic-studio-v1"),
      name: "Private Acoustic Studio Block",
      description:
        "Exclusive acoustically calibrated studio booking with dedicated sound engineer support.",
      durationMinutes: 120,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      priceMinor: "16000",
      depositMinor: "5000",
      currency: "USD",
      resourceIds: [studioA.id],
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "service:beard-trim"),
      versionId: deterministicUuid(JUDGE_NAMESPACE, "service-ver:beard-trim-v1"),
      name: "Express Beard Trim",
      description: "Quick clean trim and shape-up for well-groomed maintenance.",
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      priceMinor: "3500",
      depositMinor: "1000",
      currency: "USD",
      resourceIds: [marco.id],
    },
    {
      id: deterministicUuid(JUDGE_NAMESPACE, "service:color-gloss"),
      versionId: deterministicUuid(JUDGE_NAMESPACE, "service-ver:color-gloss-v1"),
      name: "Color & Gloss",
      description: "Full multidimensional color treatment and high-shine glossing glaze.",
      durationMinutes: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      priceMinor: "14000",
      depositMinor: "4000",
      currency: "USD",
      resourceIds: [aria.id],
    },
  ];

  // Helper map for resource -> available services
  const resourceServicesMap = new Map<string, SeedService[]>();
  for (const res of resources) {
    resourceServicesMap.set(
      res.id,
      services.filter((s) => s.resourceIds.includes(res.id)),
    );
  }

  // 4. Synthetic History (past 28 days)
  const history: SeedSyntheticHistory[] = [];
  const buyerKeys = Array.from(
    { length: 20 },
    (_, i) => `buyer-${(i + 1).toString().padStart(3, "0")}`,
  );

  // Base calendar date for today
  const nowParts = getLocalDateParts(now, timeZone);
  const nowLocalDate = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));

  for (let daysAgo = 28; daysAgo >= 1; daysAgo--) {
    const targetDate = new Date(nowLocalDate.getTime() - daysAgo * 86_400_000);
    const parts = getLocalDateParts(targetDate, timeZone);
    if (parts.weekday === "Sun") continue; // Closed on Sunday

    const isMonday = parts.weekday === "Mon";
    const isSaturday = parts.weekday === "Sat";

    for (const res of resources) {
      const allowedServices = resourceServicesMap.get(res.id) ?? [];
      if (allowedServices.length === 0) continue;

      let currentMinute = 9 * 60; // 09:00
      const closeMinute = 19 * 60; // 19:00

      while (currentMinute < closeMinute - 30) {
        // Pick service
        const svcIndex = Math.floor(prng() * allowedServices.length);
        const svc = allowedServices[svcIndex]!;
        const durationWithBuffer = svc.durationMinutes + svc.bufferAfterMinutes;

        if (currentMinute + svc.durationMinutes > closeMinute) {
          break;
        }

        // Determine target fill probability for current time window
        const hour = Math.floor(currentMinute / 60);
        let fillProb = 0.7; // default weekday afternoon 12-17

        if (isSaturday) {
          fillProb = 0.85;
        } else if (isMonday && hour < 12) {
          fillProb = 0.25; // weak slot window
        } else if (hour < 12) {
          fillProb = 0.45;
        } else if (hour >= 17) {
          fillProb = 0.9;
        }

        const isBooked = prng() < fillProb;

        if (isBooked) {
          const startsAt = createDateInZone(
            parts.year,
            parts.month,
            parts.day,
            Math.floor(currentMinute / 60),
            currentMinute % 60,
            timeZone,
          );
          const endsAt = new Date(startsAt.getTime() + svc.durationMinutes * 60_000);

          // Assign buyer key (with bias toward buyer-003 and buyer-011 for repeat no-shows)
          let buyerKey = buyerKeys[Math.floor(prng() * buyerKeys.length)]!;
          if (prng() < 0.15) {
            buyerKey = prng() < 0.5 ? "buyer-003" : "buyer-011";
          }

          const leadTimeHours = Math.floor(prng() * 450); // up to ~18 days
          const depositPaid = prng() > 0.1; // 90% deposit paid

          // Determine outcome: 88% ATTENDED, 7% NO_SHOW, 5% CANCELLED_LATE
          // Higher no-show (15%) when lead_time_hours > 336 or deposit_paid = false or buyer-003/011
          let noShowRate = 0.07;
          if (
            leadTimeHours > 336 ||
            !depositPaid ||
            buyerKey === "buyer-003" ||
            buyerKey === "buyer-011"
          ) {
            noShowRate = 0.15;
          }

          let outcome: "ATTENDED" | "NO_SHOW" | "CANCELLED_LATE" | "CANCELLED_EARLY" = "ATTENDED";
          const outcomeRoll = prng();
          if (outcomeRoll < noShowRate) {
            outcome = "NO_SHOW";
          } else if (outcomeRoll < noShowRate + 0.05) {
            outcome = "CANCELLED_LATE";
          } else if (outcomeRoll < noShowRate + 0.07) {
            outcome = "CANCELLED_EARLY";
          } else {
            outcome = "ATTENDED";
          }

          const historyId = deterministicUuid(
            JUDGE_NAMESPACE,
            `history:${res.id}:${startsAt.toISOString()}:${svc.id}`,
          );

          history.push({
            id: historyId,
            resourceId: res.id,
            serviceId: svc.id,
            startsAt,
            endsAt,
            outcome,
            leadTimeHours,
            depositPaid,
            buyerKey,
          });

          currentMinute += durationWithBuffer;
        } else {
          // Advance by 30 or 45 mins to next slot opportunity
          currentMinute += 30;
        }
      }
    }
  }

  // 5. Current and Next 7 Days (Fixtures)
  const fixtures: SeedFixture[] = [];
  const requiredStates = ["CONFIRMED", "CHECKED_IN", "COMPLETED", "NO_SHOW", "CANCELLED"] as const;
  const stateAssigned = new Set<string>();

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const targetDate = new Date(nowLocalDate.getTime() + dayOffset * 86_400_000);
    const parts = getLocalDateParts(targetDate, timeZone);
    if (parts.weekday === "Sun") continue; // Closed on Sunday

    const isMonday = parts.weekday === "Mon";
    const isTuesday = parts.weekday === "Tue";

    for (const res of resources) {
      const allowedServices = resourceServicesMap.get(res.id) ?? [];
      if (allowedServices.length === 0) continue;

      let currentMinute = 9 * 60; // 09:00
      const closeMinute = 19 * 60; // 19:00

      while (currentMinute < closeMinute - 30) {
        const hour = Math.floor(currentMinute / 60);

        // Leave clear intentional gaps: Monday morning (09-12) & Tuesday 09-11
        if (isMonday && hour < 12) {
          currentMinute += 30;
          continue;
        }
        if (isTuesday && hour >= 9 && hour < 11) {
          currentMinute += 30;
          continue;
        }

        const svcIndex = Math.floor(prng() * allowedServices.length);
        const svc = allowedServices[svcIndex]!;
        const durationWithBuffer = svc.durationMinutes + svc.bufferAfterMinutes;

        if (currentMinute + svc.durationMinutes > closeMinute) {
          break;
        }

        // ~55% average booking rate for future slots
        const isBooked = prng() < 0.55;

        if (isBooked) {
          const startsAt = createDateInZone(
            parts.year,
            parts.month,
            parts.day,
            Math.floor(currentMinute / 60),
            currentMinute % 60,
            timeZone,
          );
          const endsAt = new Date(startsAt.getTime() + svc.durationMinutes * 60_000);
          const buyerKey = buyerKeys[Math.floor(prng() * buyerKeys.length)]!;

          // Select displayStatus ensuring all required states appear
          let displayStatus: "CONFIRMED" | "CHECKED_IN" | "COMPLETED" | "NO_SHOW" | "CANCELLED" =
            "CONFIRMED";

          if (dayOffset === 0) {
            // Today: can show CHECKED_IN, COMPLETED, NO_SHOW
            if (!stateAssigned.has("COMPLETED") && startsAt.getTime() < now.getTime()) {
              displayStatus = "COMPLETED";
              stateAssigned.add("COMPLETED");
            } else if (!stateAssigned.has("CHECKED_IN")) {
              displayStatus = "CHECKED_IN";
              stateAssigned.add("CHECKED_IN");
            } else if (!stateAssigned.has("NO_SHOW")) {
              displayStatus = "NO_SHOW";
              stateAssigned.add("NO_SHOW");
            } else {
              displayStatus = "CONFIRMED";
            }
          } else {
            if (!stateAssigned.has("CANCELLED") && prng() < 0.1) {
              displayStatus = "CANCELLED";
              stateAssigned.add("CANCELLED");
            } else {
              displayStatus = "CONFIRMED";
              stateAssigned.add("CONFIRMED");
            }
          }

          const fixtureId = deterministicUuid(
            JUDGE_NAMESPACE,
            `fixture:${res.id}:${startsAt.toISOString()}:${svc.id}`,
          );

          fixtures.push({
            id: fixtureId,
            resourceId: res.id,
            serviceId: svc.id,
            startsAt,
            endsAt,
            displayStatus,
            buyerKey,
            depositPaid: displayStatus !== "CANCELLED",
          });

          currentMinute += durationWithBuffer;
        } else {
          currentMinute += 30;
        }
      }
    }
  }

  // Fallback: Ensure any missing required state is explicitly represented
  for (const reqState of requiredStates) {
    if (!stateAssigned.has(reqState) && fixtures.length > 0) {
      const idx = Math.floor(prng() * fixtures.length);
      fixtures[idx]!.displayStatus = reqState;
      stateAssigned.add(reqState);
    }
  }

  return {
    seedVersion: JUDGE_SEED_VERSION,
    timeZone,
    merchant: {
      id: merchantId,
      tenantId: JUDGE_TENANT_ID,
      name: "Velvet Studio",
      locationId,
      locationName: "SoHo Flagship",
    },
    resources,
    services,
    history,
    fixtures,
  };
}
