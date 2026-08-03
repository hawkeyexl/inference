/**
 * Ensemble consensus math. `partial` counts as fail for the binary outcome
 * but stays visible in the vote counts. Errored runs count against consensus —
 * they can only push a result toward human review, never toward a silent pass.
 */
import type { ConsensusResult, JudgeRun, Match } from "./types.js";

export function computeConsensus(
  runs: JudgeRun[],
): Omit<ConsensusResult, "zone"> {
  const votes = { pass: 0, fail: 0, partial: 0, error: 0 };
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const run of runs) {
    if (!run.verdict) {
      votes.error += 1;
      continue;
    }
    votes[run.verdict.match] += 1;
    confidenceSum += run.verdict.confidence;
    confidenceCount += 1;
  }

  const passVotes = votes.pass;
  const failVotes = votes.fail + votes.partial;
  // Binary majority; a tie is not a pass.
  const verdict: Match = passVotes > failVotes ? "pass" : "fail";
  const graded = passVotes + failVotes;
  const agreement = graded > 0 ? Math.max(passVotes, failVotes) / graded : 0;
  const meanConfidence =
    confidenceCount > 0 ? confidenceSum / confidenceCount : 0;

  return { runs, votes, verdict, agreement, meanConfidence };
}
