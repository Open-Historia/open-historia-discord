/*! Open Historia — Discord edition: deterministic ids. © 2026 Nicholas Krol, MIT. */
// Op ids are derived from (round, nation, decisionKey, method) so re-running the
// same round produces the SAME opId — that is what makes the write-ahead ops log
// idempotent across a crash/reboot: a replay skips ops already marked applied,
// and even a duplicate enqueue collapses to one row.
const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const opId = ({ round, nation = "", decisionKey, method }) =>
  ["r" + Number(round || 0), slug(nation), slug(decisionKey), slug(method)].filter(Boolean).join(":");

export const ballotId = ({ round, nation = "", decisionKey }) =>
  ["b", "r" + Number(round || 0), slug(nation), slug(decisionKey)].filter(Boolean).join(":");
