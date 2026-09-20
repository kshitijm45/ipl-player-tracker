/**
 * Source adapter contract.
 *
 * Every data source — free, paid, official, or scraped — implements this same
 * interface and returns the same normalised shape. That is what makes the
 * coverage strategy work: no single free source covers everything CREX shows, so
 * the product composes several, and each one can fail independently.
 *
 * Two rules every adapter must honour:
 *
 *  1. Never invent a player. Resolve through the registry and quarantine anything
 *     that comes back 'ambiguous' or 'unknown'. A wrong attribution is worse than
 *     a missing one — silently crediting Rohit Sharma's century to a different
 *     Rohit Sharma destroys trust in every number on the page.
 *
 *  2. Always pass squad context to resolve(). Scorecards know who was playing;
 *     that context is what turns an ambiguous name into an exact match.
 */

/** @typedef {'batting'|'bowling'|'fielding'} Discipline */

/**
 * @typedef {Object} Performance
 * @property {string} playerId      Canonical Cricsheet identifier.
 * @property {string} matchId       Source-scoped match id.
 * @property {string} date          ISO date (YYYY-MM-DD).
 * @property {string} competition   e.g. "IPL", "BBL", "TNPL", "Test".
 * @property {string} format        "T20" | "ODI" | "Test" | "T10".
 * @property {string} team
 * @property {string} opposition
 * @property {Object} [batting]     { runs, balls, fours, sixes, out }
 * @property {Object} [bowling]     { overs, maidens, runs, wickets }
 * @property {Object} [fielding]    { catches, stumpings, runOuts }
 * @property {string} source        Adapter id that produced this row.
 */

export class Source {
  /**
   * @param {Object} opts
   * @param {string} opts.id            Stable adapter id, e.g. 'cricsheet'.
   * @param {string} opts.label         Human-readable name.
   * @param {number} opts.priority      Lower wins when sources disagree.
   * @param {string[]} opts.competitions Competitions this source can serve.
   * @param {boolean} [opts.live]       Can it deliver same-day data?
   */
  constructor({ id, label, priority, competitions, live = false }) {
    this.id = id;
    this.label = label;
    this.priority = priority;
    this.competitions = competitions;
    this.live = live;
  }

  /**
   * Fetch performances in a date range.
   * Must resolve to { performances: Performance[], quarantined: Array }.
   * @returns {Promise<{performances: Performance[], quarantined: Array}>}
   */
  async fetchPerformances(/* { from, to, registry } */) {
    throw new Error(`${this.id}: fetchPerformances not implemented`);
  }

  /** Cheap liveness probe so the runner can skip a broken source. */
  async healthCheck() {
    return { ok: true };
  }
}

/**
 * Helper for adapters: resolve a scorecard entry or quarantine it.
 * Returns null when the caller should skip the row.
 */
export function resolveOrQuarantine({ registry, entry, quarantined, context }) {
  const res = registry.resolve({
    sourceKey: entry.sourceKey,
    sourceId: entry.sourceId,
    name: entry.name,
    hint: { squad: context?.squad },
  });

  if (res.player && (res.confidence === 'exact' || res.confidence === 'name')) {
    return res.player;
  }

  quarantined.push({
    name: entry.name,
    confidence: res.confidence,
    reason: res.reason,
    candidates: res.candidates?.map((c) => ({
      id: c.identifier,
      name: c.unique_name,
    })),
    context,
  });
  return null;
}
