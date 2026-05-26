// Quick, deterministic heuristic. Returns true if `text` looks like the user
// stopped mid-thought. We over-reject (return false) to avoid annoying false
// positives; the AI still gets a chance to refuse to complete.
const HANGING_WORDS = new Set([
  'und','aber','oder','denn','weil','obwohl','damit','dass','dassen','ich','wir',
  'du','er','sie','es','der','die','das','ein','eine','einen','mit','von','bei',
  'für','zu','nach','vor','auf','bis','dann','wenn','was','wie','warum',
  // English fallbacks (some chats mixed)
  'and','but','or','because','that','i','we','you','the','a','to','of','at','for',
]);

export function looksIncomplete(text) {
  if (!text) return false;
  const t = String(text).trim();
  // Too short -> probably complete ("ok", "ja", "lol")
  if (t.length < 6) return false;
  // Ends with sentence terminator -> complete
  if (/[.!?…)]$/.test(t)) return false;
  // Ends with a hanging connector
  const m = t.toLowerCase().match(/([a-zäöüß']+)[\s,;:]*$/);
  if (m && HANGING_WORDS.has(m[1])) return true;
  // Ends with a comma -> probably continuing
  if (/,\s*$/.test(t)) return true;
  // Ends mid-word (no space, ends with hyphen)
  if (t.endsWith('-')) return true;
  // Long sentence without final punctuation
  if (t.split(' ').length >= 6 && !/[.!?…]$/.test(t)) return true;
  return false;
}
