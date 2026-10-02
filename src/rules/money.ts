// The one rounding rule (D16): integer n / d, half up (.5 away from zero, as the oracle's ROUND_HALF_UP). Integer
// arithmetic only: `%` and the exact division after subtracting the remainder never touch a fraction.
export function divHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d === 0) throw new Error(`divHalfUp(${n}, ${d}): not exact integer math`);
  const a = Math.abs(n), b = Math.abs(d), r = a % b;
  const q = (a - r) / b + (2 * r >= b ? 1 : 0);
  return (n < 0) !== (d < 0) && q !== 0 ? -q : q; // never -0
}

// bps of an amount: amount * bps / 10000, half up.
export const applyBps = (cents: number, bps: number): number => divHalfUp(cents * bps, 10000);
