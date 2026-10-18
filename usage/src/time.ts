/** Time display for the site: exact date and time in the org's zone (IST by default), UTC on hover, and "in 7 h". */

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

const ZONE_LABEL: Readonly<Record<string, string>> = { "Asia/Kolkata": "IST", UTC: "UTC" };

/** "IST" for Asia/Kolkata, otherwise the zone name itself. */
export const zoneLabel = (tz: string): string => ZONE_LABEL[tz] ?? tz;

/** An unusable TIME_ZONE (typo) falls back to the default instead of breaking every page. */
export function safeZone(tz: string | undefined): string {
  const zone = tz?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Oct 2026, 05:30". Month names are fixed here: Intl's short names differ by runtime ("Sept" in en-GB). */
function stamp(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const p = (type: string): string => parts.find((x) => x.type === type)?.value ?? "";
  return `${Number(p("day"))} ${MONTHS[Number(p("month")) - 1]} ${p("year")}, ${p("hour")}:${p("minute")}`;
}

/** "19 Oct 2026, 05:30 IST", with the same instant in UTC for a tooltip. */
export function formatInstant(iso: string, tz: string): { text: string; utc: string } {
  const ms = Date.parse(iso);
  return { text: `${stamp(ms, tz)} ${zoneLabel(tz)}`, utc: `${stamp(ms, "UTC")} UTC` };
}

/** "in 7 h", "in 12 days", "3 h ago", "just now". */
export function relative(iso: string, now: Date): string {
  const diff = Date.parse(iso) - now.getTime();
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return "just now";
  const span =
    mins < 90
      ? `${mins} min`
      : mins < 48 * 60
        ? `${Math.round(mins / 60)} h`
        : `${Math.round(mins / 1440)} days`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** How a quota resets: on UTC midnight, on the 1st of the month, rolling, at the platform's billing cycle, or never. */
export type Cycle = "utc-day" | "utc-month" | "rolling" | "billing" | "none";

/** The next reset of a calendar-based quota (ISO), or undefined when it depends on the platform. */
export function nextReset(cycle: Cycle, now: Date): string | undefined {
  if (cycle === "utc-day") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
  }
  if (cycle === "utc-month") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  return undefined;
}

/** Whole days until `iso` (negative once past). */
export function daysUntil(iso: string, now: Date): number {
  return Math.floor((Date.parse(iso) - now.getTime()) / 86_400_000);
}
