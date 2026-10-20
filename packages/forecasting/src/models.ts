export interface NoShowFeatures {
  leadTimeHours: number;
  weekday: number; // 0-6
  depositTier: "NONE" | "PARTIAL" | "FULL";
  rescheduleCount: number;
}

export interface NoShowPrediction {
  probability: number;
  riskBand: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  modelVersion: string;
}

/**
 * Baseline statistical model estimating appointment no-show probability.
 */
export function predictNoShowProbability(features: NoShowFeatures): NoShowPrediction {
  let p = 0.12; // Base prior (12%)

  // Lead time effect: bookings made far in advance have higher no-show risk
  if (features.leadTimeHours > 168) {
    p += 0.08;
  } else if (features.leadTimeHours < 24) {
    p -= 0.04;
  }

  // Deposit tier effect: higher deposits strongly reduce no-shows
  if (features.depositTier === "FULL") {
    p -= 0.09;
  } else if (features.depositTier === "PARTIAL") {
    p -= 0.04;
  } else {
    p += 0.06;
  }

  // Reschedule count effect
  if (features.rescheduleCount > 1) {
    p += 0.05 * features.rescheduleCount;
  }

  // Bound to [0.01, 0.95]
  const probability = Math.min(Math.max(p, 0.01), 0.95);

  let riskBand: "low" | "medium" | "high" = "low";
  if (probability >= 0.25) {
    riskBand = "high";
  } else if (probability >= 0.12) {
    riskBand = "medium";
  }

  return {
    probability: Math.round(probability * 100) / 100,
    riskBand,
    confidence: "medium",
    modelVersion: "baseline-heuristic-v1.0.0",
  };
}

export interface SlotFillFeatures {
  leadTimeHours: number;
  weekday: number;
  hourOfDay: number;
}

export function predictSlotFillProbability(features: SlotFillFeatures): number {
  let p = 0.65;
  // Peak hours (10am - 4pm)
  if (features.hourOfDay >= 10 && features.hourOfDay <= 16) {
    p += 0.15;
  }
  // Weekend effect
  if (features.weekday === 0 || features.weekday === 6) {
    p += 0.1;
  }
  // Short lead time discount
  if (features.leadTimeHours < 4) {
    p -= 0.25;
  }
  return Math.min(Math.max(Math.round(p * 100) / 100, 0.05), 0.95);
}
