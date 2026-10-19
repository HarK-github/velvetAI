/**
 * Calculates Brier Score for probability predictions.
 * Brier = (1/N) * sum((forecast - actual)^2)
 * range [0, 1] where 0 is perfect.
 */
export function calculateBrierScore(predictions: number[], actuals: (0 | 1)[]): number {
  if (predictions.length === 0 || predictions.length !== actuals.length) {
    throw new Error("Predictions and actuals must be non-empty arrays of identical length");
  }
  const sumSquaredDiff = predictions.reduce((sum, p, i) => {
    const a = actuals[i]!;
    return sum + Math.pow(p - a, 2);
  }, 0);
  return sumSquaredDiff / predictions.length;
}

/**
 * Calculates Weighted Absolute Percentage Error (WAPE) for revenue/cash forecasts.
 * WAPE = sum(|actual - forecast|) / sum(actual)
 */
export function calculateWAPE(forecasts: number[], actuals: number[]): number {
  if (forecasts.length === 0 || forecasts.length !== actuals.length) {
    throw new Error("Forecasts and actuals must be non-empty arrays of identical length");
  }
  const totalActual = actuals.reduce((sum, a) => sum + a, 0);
  if (totalActual === 0) {
    return 0;
  }
  const totalError = forecasts.reduce((sum, f, i) => sum + Math.abs((actuals[i] ?? 0) - f), 0);
  return totalError / totalActual;
}
