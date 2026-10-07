/**
 * How good was this performance?
 *
 * Used to order "Performance of the day" and the per-day lists. It is a ranking, not a
 * rating: the number means nothing on its own and is never shown. All it has to do is
 * put the better performance above the worse one.
 *
 * It replaces `runs + wickets * 25`, which was wrong in two ways that showed on the
 * page. A wicket was worth 25 runs in every format, so 3 for 62 off twenty Test overs
 * outranked a 76; and nothing but the raw counts mattered, so a 125 off 79 in an ODI
 * sat below 5 for 80 off 18.2. Strike rate, economy and format all had no bearing on
 * an order they obviously belong in.
 *
 * The shape here is simple and deliberately so: measure a performance against what its
 * own format expects, and sum the two disciplines. An allrounder's 40 and 2 for 20
 * should beat either half alone, which is the one thing both versions agree on.
 */

/**
 * What a format expects, roughly: a par strike rate, a par economy, and what a wicket
 * is worth in runs.
 *
 * These are judgement calls, not measurements, and they are meant to be. A wicket is
 * worth more in a Test than in a T10 because there are fewer of them to take and they
 * cost more to buy; a strike rate of 130 is ordinary in a T20 and extraordinary in a
 * Test. Getting these roughly right is what makes the order sensible; getting them
 * exactly right is not possible, since no single number describes a match situation.
 */
export const PAR = {
  T20: { strikeRate: 130, economy: 8.0, wicket: 18 },
  T10: { strikeRate: 160, economy: 10.5, wicket: 14 },
  '100B': { strikeRate: 130, economy: 8.0, wicket: 16 },
  ODI: { strikeRate: 90, economy: 5.5, wicket: 24 },
  Test: { strikeRate: 55, economy: 3.2, wicket: 30 },
};

/** An unknown format is treated as a T20, which is what most cricket here is. */
export function parFor(format) {
  return PAR[format] ?? PAR.T20;
}

/**
 * The batting half.
 *
 * Runs are the base, with a bonus or penalty for the balls they took: a 50 off 25 and
 * a 50 off 60 are not the same innings, and in a T20 the second can lose a match. The
 * adjustment is expressed in runs — how many more (or fewer) the batsman scored than a
 * par striker would have off the same balls — so the two terms share a unit.
 *
 * A not-out is worth a little, but only on a substantial score: 4 not out off 2 balls
 * is not a performance, and rewarding it would push tail-enders up the list.
 */
export function battingImpact(batting, par) {
  if (!batting || batting.runs == null) return 0;
  const balls = batting.balls ?? 0;
  let v = batting.runs;

  if (balls > 0) {
    // Tempo, as runs gained or lost against a par striker facing the same balls —
    // capped so it shades an innings without deciding it. Uncapped, this term grows
    // with every ball faced, and a slow innings was eventually worth less than no
    // innings at all.
    const sr = (batting.runs / balls) * 100;
    const delta = ((sr - par.strikeRate) * balls) / 100;
    v += clamp(delta, -batting.runs / 2, batting.runs / 2);

    // Occupation, which matters most where it is scarcest. Surviving thirty balls for
    // nothing is a contribution in a Test and barely one in a T10; the old score and
    // the first version of this one both had it the wrong way round, ranking a duck
    // off one ball above a duck off thirty because only the tempo penalty applied.
    v += (balls / 100) * (100 / par.strikeRate) * 2;
  }

  if (batting.out === false && batting.runs >= 20) v += 5;
  return v;
}

/** Keep a value inside a range. */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The bowling half.
 *
 * Wickets are the base. The rest is runs saved against par over the overs actually
 * bowled, which is what separates 3 for 20 from 3 for 62 — the old version could not,
 * and ranked twenty expensive overs alongside a genuine spell.
 *
 * Where balls bowled is unknown the economy term is simply skipped rather than guessed
 * at, so a figure still waiting on its scorecard ranks on wickets alone. That is the
 * same rule the career stats follow: a missing number is missing, not zero.
 */
export function bowlingImpact(bowling, par) {
  if (!bowling) return 0;
  const wickets = bowling.wickets ?? 0;
  let v = wickets * par.wicket;

  if (bowling.balls > 0 && bowling.runs != null) {
    const overs = bowling.balls / 6;
    const economy = bowling.runs / overs;

    // Economy is judged as a rate and then given weight by the length of the spell,
    // rather than multiplied out over it. The difference matters: multiplying made
    // bowling *more* overs worth more by itself, so twenty expensive overs outranked
    // four cheap ones that took the same wickets, and in the high-par formats the
    // economy term alone outweighed a wicket.
    //
    // The weight rises with the spell but saturates, so a longer spell is taken more
    // seriously without length itself becoming the score. Four overs — a full T20
    // spell — is where it is already most of the way there.
    const weight = Math.min(overs, 4) / 4;
    v += (par.economy - economy) * weight * 4;

    // Runs conceded carry a small cost of their own, independent of the rate. Without
    // it, two spells taking the same wickets rank by economy alone, and a long spell
    // at a respectable rate outranks a short one that was simply better: 3 for 62 off
    // twenty beat 3 for 20 off four, because its economy was only a little worse and
    // nothing else counted against the extra forty-two runs.
    v -= bowling.runs / 5;
  }

  return v;
}

/**
 * One performance's score. Higher is better; the value is ordinal and never displayed.
 */
export function impact(row) {
  const par = parFor(row?.format);
  return Math.round(battingImpact(row?.batting, par) + bowlingImpact(row?.bowling, par));
}

/**
 * Why this performance ranked where it did, in words a reader would use.
 *
 * The score is meaningless on its own, so the page shows this instead where it has
 * room — "66 off 31" rather than "82".
 */
export function describe(row) {
  const parts = [];
  const b = row?.batting;
  const w = row?.bowling;
  if (b && b.runs != null && (b.balls || b.runs)) {
    parts.push(`${b.runs}${b.out === false ? '*' : ''}${b.balls ? ` off ${b.balls}` : ''}`);
  }
  if (w && (w.wickets || w.runs != null)) {
    const overs = w.balls > 0 ? ` in ${(w.balls / 6).toFixed(1)} ov` : '';
    parts.push(`${w.wickets ?? 0}/${w.runs ?? 0}${overs}`);
  }
  return parts.join(' & ');
}
