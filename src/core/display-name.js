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
  // A CREX name is only trusted when it plausibly names the same person. Slugs are
  // harvested from scorecards and pinned by hand, and a mispin once put "Ankush
  // Kumar" over Ashwani Kumar — same surname family, different cricketer. Requiring
  // the surnames to agree turns that from a silent rename into a skipped override.
  const trustedCrex = crexName && sameSurname(crexName, registerName) ? crexName : null;

  const candidates = [trustedCrex, listedAs, registerName];
  for (const c of candidates) {
    if (c && looksLikeCommonName(c)) return c;
  }
  return trustedCrex || listedAs || registerName;
}

/**
 * Could these two names be the same person?
 *
 * The surname must match, and the given name must be *compatible*: either the
 * register gives only an initial cluster ("MD Shanaka" vs "Dasun Shanaka", where D
 * appears in the cluster), or both spell a given name and those names agree.
 *
 * Surname alone is not enough — "Ankush Kumar" and "Ashwani Kumar" share "Kumar"
 * and are different cricketers. Requiring the given names to line up is what
 * separates a legitimate expansion from a mispin.
 */
export function sameSurname(a, b) {
  if (!a || !b) return false;

  const tidy = (s) =>
    String(s).trim().toLowerCase().replace(/\s*\(\d+\)\s*$/, '').split(/\s+/).filter(Boolean);
  const A = tidy(a);
  const B = tidy(b);
  if (!A.length || !B.length) return false;

  // Surnames can be multi-word ("de Kock", "du Plessis"). Compare the last token,
  // which is stable across both spellings.
  if (A[A.length - 1] !== B[B.length - 1]) return false;

  const givenA = A.slice(0, -1);
  const givenB = B.slice(0, -1);
  if (!givenA.length || !givenB.length) return true; // nothing to contradict

  // Drop particles so "Q de Kock" compares on "q", not "de".
  const PARTICLES = new Set(['de', 'du', 'van', 'von', 'da', 'del', 'la', 'le', 'bin', 'al']);
  const coreA = givenA.filter((t) => !PARTICLES.has(t));
  const coreB = givenB.filter((t) => !PARTICLES.has(t));
  if (!coreA.length || !coreB.length) return true;

  const gA = coreA.join('');
  const gB = coreB.join('');
  // An initial cluster is simply a very short given-name field: "TA", "SA", "JO",
  // "MD". Testing for absent vowels fails on exactly those, since A and O are vowels.
  const isCluster = (g) => g.length <= 3;

  // An initial cluster is compatible with a spelled name that starts with any of
  // its letters: "TA" ~ "Trent", "MD" ~ "Dasun", "SA" ~ "Suryakumar".
  if (isCluster(gA) !== isCluster(gB)) {
    const [cluster, spelled] = isCluster(gA) ? [gA, gB] : [gB, gA];
    return cluster.split('').some((ch) => spelled.startsWith(ch));
  }

  // Both spelled out: allow ordinary transliteration drift ("Nithish"/"Nitish",
  // "P Simran"/"Prabhsimran") but not two different names ("Shashank"/"Shamsher").
  if (!isCluster(gA) && !isCluster(gB)) {
    if (gA === gB) return true;
    if (gA.startsWith(gB) || gB.startsWith(gA)) return true;
    return editDistance(gA, gB) <= Math.max(1, Math.floor(Math.min(gA.length, gB.length) / 5));
  }

  // Both clusters: require a shared leading initial.
  return gA[0] === gB[0];
}

/** Levenshtein distance, capped short — these are single names, not documents. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
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
