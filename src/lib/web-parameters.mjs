const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const UNSIGNED_INTEGER = /^\d+$/;

export function parseNumericInput(value, { integer = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!(integer ? UNSIGNED_INTEGER : DECIMAL).test(raw)) return Number.NaN;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (integer && !Number.isSafeInteger(parsed)) return Number.NaN;
  return parsed;
}
