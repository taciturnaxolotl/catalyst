// what a cue is doing right now, derived from state + a timestamp. shared by the
// overlay and the operator panel so they can never disagree about what's on screen.

const MIN = 60000;

// a repeating cue rolls forward on its own: the target is a pure function of
// (at, every, now), so a tab waking from hibernation lands on the same second
// as every other tab without asking the server.
export function target(c, t) {
  if (c.at === null) return null;
  if (!c.every) return c.at;
  const step = c.every * MIN;
  const slip = t - c.hold * MIN - c.at;
  return c.at + Math.max(0, Math.ceil(slip / step)) * step;
}

// "queued" — scheduled, not on screen yet. "live" — on screen. "lapsed" — its
// moment came and went. "off" — the operator parked it. "pinned" — forced on.
export function status(c, t) {
  if (c.show === "off") return "off";
  if (c.show === "on") return "pinned";
  const tgt = target(c, t);
  if (tgt === null) return "live";
  if (t > tgt + c.hold * MIN) return "lapsed";
  if (c.lead !== null && tgt - t > c.lead * MIN) return "queued";
  return "live";
}

export const onAir = (c, t) => {
  const s = status(c, t);
  return s === "live" || s === "pinned";
};

// "45s" / "20 min" / "1h 05m" / "3d 4h" / "now"
export function until(ms) {
  if (ms <= 0) return "now";
  const t = Math.round(ms / 1000);
  if (t < 60) return `${t}s`;
  const m = Math.round(t / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  // past a day, minutes are noise — a cue booked for saturday reads as "3d 4h"
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
