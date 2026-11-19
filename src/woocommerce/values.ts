/**
 * Value rules shared by tool schemas, handlers and the change resolution.
 *
 * The WooCommerce REST API documentation: "Resource IDs are returned as
 * integers", "Any decimal monetary amount, such as prices or totals, will be
 * returned as strings with two decimal places", and dates in ISO 8601.
 */

/** Largest refund amount accepted, in the order's currency. */
export const MAX_AMOUNT = 100_000_000;

/** A price as WooCommerce takes it: a decimal string with at most four decimals, e.g. "199.95". */
export const PRICE_PATTERN = /^\d{1,9}(\.\d{1,4})?$/;

/** ISO 4217 currency code. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function isRecordId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A calendar date written YYYY-MM-DD that exists. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A positive amount of at most two decimals and at most MAX_AMOUNT. */
export function isAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_AMOUNT &&
    Math.abs(Math.round(value * 100) - value * 100) < 1e-6
  );
}

export function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

/** A money value from WooCommerce ("12.50") as a number, or undefined when it is not one. */
export function money(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d{1,12}(\.\d{1,6})?$/.test(value.trim())) return undefined;
  return Number(value.trim());
}
