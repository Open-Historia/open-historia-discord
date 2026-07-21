/*! Open Historia — Discord edition: vote tallying (pure). © 2026 Nicholas Krol, MIT. */
// Plurality with a deterministic tie-break (earliest option in the ballot's own
// order wins), so the same votes always resolve the same way — important for the
// idempotent reconcile. An empty ballot (nobody voted) yields no winner, which the
// caller treats as "abstain -> no op this round".

// votes: { userId: optionId }. options: [{ id, ... }] in ballot order.
export const tally = (votes, options) => {
  const counts = new Map(options.map((o) => [o.id, 0]));
  let total = 0;
  for (const optionId of Object.values(votes || {})) {
    if (counts.has(optionId)) {
      counts.set(optionId, counts.get(optionId) + 1);
      total += 1;
    }
  }
  let winner = null;
  let best = -1;
  for (const opt of options) {
    // strict > keeps the FIRST option among ties (options iterate in ballot order)
    if (counts.get(opt.id) > best) {
      best = counts.get(opt.id);
      winner = opt.id;
    }
  }
  return {
    winner: total > 0 ? winner : null, // no votes => abstain
    winnerVotes: best,
    total,
    counts: Object.fromEntries(counts),
  };
};

// Quorum helper: at least `min` votes cast for the result to count.
export const meetsQuorum = (total, min = 1) => total >= Math.max(1, min);
