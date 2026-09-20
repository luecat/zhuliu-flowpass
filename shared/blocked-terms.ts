import { foldChineseVariants } from './chinese-variants';

/**
 * Denylist matching. The terms come from the program's own softwareBlacklist
 * (or the shipped seed in default-blocked-vendors.ts) — this module only
 * decides whether a piece of text contains one, so every rejection traces back
 * to a list entry a reviewer can read.
 *
 * Comparison folds traditional characters to simplified and lowercases, so a
 * list written in either script matches a receipt printed in either script.
 */

/**
 * A short latin term ("wps", "vidu", "360") has to match as a whole word.
 * Left as a substring it fires inside ordinary words — "vidu" is in
 * "individual", which is exactly the kind of false rejection that would make
 * an eligible applicant unable to proceed. CJK terms are not word-delimited
 * and are matched as substrings regardless of length.
 */
const SHORT_LATIN_LENGTH = 6;
const LATIN_TERM = /^[\p{ASCII}]+$/u;

function normalize(value: string): string {
  return foldChineseVariants(value.normalize('NFKC')).toLocaleLowerCase();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BlockedTermMatch {
  /** The denylist entry that fired, as the list spells it. */
  term: string;
  /** The text as the document spells it, for quoting back to the applicant. */
  matched: string;
}

export function matchBlockedTerm(value: string, terms: readonly string[]): BlockedTermMatch | null {
  const source = value.normalize('NFKC').trim();
  if (!source) return null;
  const haystack = normalize(source);

  for (const term of terms) {
    const needle = normalize(term).trim();
    if (!needle) continue;
    let index = -1;
    if (LATIN_TERM.test(needle) && needle.length < SHORT_LATIN_LENGTH) {
      const bounded = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u');
      index = bounded.exec(haystack)?.index ?? -1;
    } else {
      index = haystack.indexOf(needle);
    }
    if (index < 0) continue;
    // Folding and lowercasing are character-for-character, so the index still
    // points at the same place in the untouched text.
    return { term, matched: source.slice(index, Math.min(index + needle.length, source.length)) };
  }
  return null;
}

export function containsBlockedTerm(value: string, terms: readonly string[]): boolean {
  return matchBlockedTerm(value, terms) !== null;
}
