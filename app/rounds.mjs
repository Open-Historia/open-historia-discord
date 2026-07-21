/*! Open Historia — Discord edition: round resolution (testable). © 2026 Nicholas Krol, MIT. */
// The tally -> write-ahead ops -> flush pipeline, isolated from discord.js so it
// can be unit-tested with a mock bridge. Each queued action and the single
// resolveRound get a deterministic opId (round + decisionKey), so a crash between
// enqueue and flush replays exactly the ops that didn't finish — never twice.
import { tally } from "./tally.mjs";
import { opId as makeOpId } from "./ids.mjs";
import * as store from "./persistence.mjs";
import { timing } from "./config.mjs";

export async function resolveRound(guildId, ohFn) {
  const game = store.getGame(guildId);

  // 1) Each open ballot -> its plurality winner -> a queueActionFor op.
  const ops = [];
  for (const ballot of Object.values(game.ballots)) {
    const votes = game.votes[ballot.id] || {};
    const result = tally(votes, ballot.options);
    if (!result.winner) continue; // nobody voted -> abstain, no op for this ballot
    const opt = ballot.options.find((o) => o.id === result.winner);
    if (!opt || !opt.text) continue;
    ops.push({
      opId: makeOpId({ round: game.round, nation: ballot.nation || game.primaryNation, decisionKey: ballot.decisionKey, method: "queueActionFor" }),
      method: "queueActionFor",
      args: [ballot.nation || game.primaryNation, opt.text],
    });
  }

  // 2) Exactly one resolveRound AFTER the queue ops.
  ops.push({
    opId: makeOpId({ round: game.round, decisionKey: "resolve", method: "resolveRound" }),
    method: "resolveRound",
    args: [{ days: timing.jumpDays }],
  });
  store.enqueueOps(guildId, ops);

  // 3) Flush in seq order; mark applied only after each returns.
  let summary = null;
  for (const op of store.pendingOps(guildId)) {
    const res = await ohFn(op.method, ...op.args);
    if (op.method === "resolveRound") summary = res;
    store.markOpApplied(guildId, op.opId);
  }
  store.clearOps(guildId);
  store.clearBallots(guildId);
  return summary;
}
