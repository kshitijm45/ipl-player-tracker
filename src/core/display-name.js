/**
 * Display names.
 *
 * Cricsheet stores players the way scorecards print them — "MD Shanaka", "YBK Jaiswal",
 * "RG Sharma" — which is precise but not how anyone talks about them. The site shows the
 * common name instead, resolved in this order:
 *
 *   1. CREX profile/scorecard name  ("Dasun Shanaka")  — the name fans actually use
 *   2. the squad-list name           ("Dasun Shanaka")  — already on file for all 260
 *   3. the register name             ("MD Shanaka")     — last resort, never wrong
 *
 * Identity is unaffected: the canonical id still comes from the register, so changing
 * the label can never merge or split two players.
 */

/**
 * @param {object} opts
 * @param {string} opts.registerName  Cricsheet `unique_name`, e.g. "MD Shanaka".
 * @param {string|null} [opts.listedAs]  Squad-list spelling, e.g. "Dasun Shanaka".
 * @param {string|null} [opts.crexName]  Name harvested from CREX.
 */
export function displayName({ registerName, listedAs, crexName }) {
  const candidates = [crexName, listedAs, registerName];
  for (const c of candidates) {
    if (c && looksLikeCommonName(c)) return c;
  }
  return crexName || listedAs || registerName;
}

/**
 * A common name has at least one spelled-out given name. "MD Shanaka" and "YBK Jaiswal"
 * fail this; "Dasun Shanaka" and "MS Dhoni" pass — the latter because initials-only names
 * are how that player is genuinely known, and the register is then already correct.
 */
export function looksLikeCommonName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return false;

  // A leading token of 2-4 capitals with no vowel pattern is an initial cluster
  // ("MD", "YBK", "PVD"). Treat a name as common if its first token is not that.
  const first = parts[0].replace(/[.]/g, '');
  const isInitialCluster = /^[A-Z]{1,4}$/.test(first) && first.length <= 4 && !/[aeiou]/i.test(first.slice(1));

  // Well-known exceptions: players universally referred to by initials.
  const KNOWN_INITIALS = new Set(['MS Dhoni', 'AB de Villiers', 'JP Duminy', 'KL Rahul']);
  if (KNOWN_INITIALS.has(name)) return true;

  return !isInitialCluster;
}

/** Strip a trailing disambiguator the register adds, e.g. "Arshad Khan (2)". */
export function stripDisambiguator(name) {
  return name.replace(/\s*\(\d+\)\s*$/, '').trim();
}
