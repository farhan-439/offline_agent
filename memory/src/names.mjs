// Grounded identity: decide what is a person's name, what is a form of address, and what
// relation words are allowed. A 4B model happily returns "?", "owner", "Mom" or
// "daughter of S1" as a person; enrolling a voiceprint to one of those poisons identity for
// good, so names are validated deterministically before anything is written.

const TITLE = /^(?:dr|doctor|mr|mrs|ms|miss|prof|professor)\.?\s+/i;

// Words that look like names in text but are not a person we should create.
const NOT_NAMES = new Set([
  '', '?', '??', 'unknown', 'none', 'null', 'n/a', 'na', 'owner', 'the owner', 'device owner',
  'me', 'myself', 'you', 'yourself', 'speaker', 'the speaker', 's1', 's2', 's0', 'label',
  'mom', 'mum', 'mother', 'dad', 'father', 'son', 'daughter', 'grandma', 'grandmother',
  'grandpa', 'grandfather', 'honey', 'dear', 'sweetie', 'buddy', 'pal', 'sir', 'ma\'am',
  'madam', 'miss', 'mister', 'mr', 'mrs', 'ms', 'dr', 'doctor', 'nurse', 'doc',
  'he', 'she', 'they', 'him', 'her', 'them', 'we', 'us', 'i', 'someone', 'somebody', 'anyone',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'today', 'tomorrow', 'yesterday', 'morning', 'afternoon',
  'evening', 'night', 'hospital', 'clinic', 'home', 'okay', 'ok', 'yes', 'no', 'hello', 'hi',
]);

const RELATION_MAP = new Map([
  ['next door', 'neighbour'], ['next-door', 'neighbour'], ['nextdoor', 'neighbour'],
  ['neighbor', 'neighbour'], ['neighbour', 'neighbour'], ['neighbors', 'neighbour'],
  ['mom', 'mother'], ['mum', 'mother'], ['mother', 'mother'], ['dad', 'father'], ['father', 'father'],
  ['grandma', 'grandmother'], ['grandmother', 'grandmother'], ['grandpa', 'grandfather'],
  ['grandfather', 'grandfather'], ['son', 'son'], ['daughter', 'daughter'],
  ['grandson', 'grandson'], ['granddaughter', 'granddaughter'], ['child', 'child'],
  ['doctor', 'doctor'], ['physician', 'doctor'], ['gp', 'doctor'], ['nurse', 'nurse'],
  ['dentist', 'dentist'], ['therapist', 'therapist'], ['friend', 'friend'], ['best friend', 'friend'],
  ['wife', 'wife'], ['husband', 'husband'], ['partner', 'partner'], ['spouse', 'spouse'],
  ['carer', 'caregiver'], ['caregiver', 'caregiver'], ['colleague', 'colleague'],
  ['coworker', 'colleague'], ['co-worker', 'colleague'], ['boss', 'boss'],
  ['landlord', 'landlord'], ['tenant', 'tenant'], ['neighbour friend', 'neighbour'],
]);

export function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[\[\]{}"“”«»]/g, ' ')
    .replace(/\s*\b(?:from|of|at)\b[\s\S]*$/i, '')
    .replace(/['’]s\b/gi, 's')
    .replace(/[\s,;:.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True only for something we are willing to store as a person and bind a voice to. */
export function isValidPersonName(name, { ownerName = null } = {}) {
  const raw = cleanName(name);
  if (!raw || raw.length < 2 || raw.length > 48) return false;
  if (!/^[\p{L}][\p{L}'’.\- ]*$/u.test(raw)) return false;
  const words = raw.split(' ');
  if (words.length > 4) return false;
  const lower = raw.toLowerCase();
  if (NOT_NAMES.has(lower)) return false;
  const bare = lower.replace(TITLE, '');
  if (!bare || NOT_NAMES.has(bare)) return false;
  if (ownerName && bare === ownerName.toLowerCase().replace(TITLE, '')) return false;
  if (/(?:^|\s)(?:of|from|the|my|your|his|her|their|a|an|and|with|speaker|s\d+)(?:\s|$)/.test(bare)) return false;
  if (/\d/.test(bare)) return false;
  const titled = TITLE.test(raw);
  const capitalised = words.some((w) => /^\p{Lu}/u.test(w));
  if (!titled && !capitalised) return false;
  return true;
}

/** Relation as a noun relative to the owner ("neighbour", "granddaughter"), or null. */
export function normalizeRelation(relation) {
  if (relation == null) return null;
  let t = String(relation).toLowerCase().trim()
    .replace(/^(?:the\s+)?(?:owner['’]?s|your|their|my)\s+/, '')
    .replace(/\s+of\s+(?:the\s+)?(?:owner|me|s\d+|speaker\s*\d+|[a-z][\w'’-]*)\s*$/i, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (!t) return null;
  if (/\b(?:s\d+|speaker|unknown|none|owner|null)\b/.test(t)) return null;
  if (RELATION_MAP.has(t)) return RELATION_MAP.get(t);
  if (t.split(/\s+/).length > 3) return null;
  if (!/^[a-z][a-z'’-]*(?:\s+[a-z'’-]+)*$/.test(t)) return null;
  return t;
}

// Self-introductions are the strongest, cheapest evidence for a name: they are said by the
// speaker about themselves, so binding that cluster's voiceprint is safe.
const TITLE_PART = '(?:(?:[Dd]octor|[Dd]r|[Mm]r|[Mm]rs|[Mm]s|[Mm]iss|[Pp]rof(?:essor)?)\\.?\\s+)?';
const NAME_PART = `(?<name>${TITLE_PART}[\\p{Lu}][\\p{L}'’\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’\\-]+){0,2})`;
const INTRO_PATTERNS = [
  new RegExp(`\\b(?:[Ii]t['’]?s|[Tt]his is|[Tt]hat['’]?s|[Ii] am|[Ii]['’]m|[Mm]y name is|[Cc]all me|[Yy]ou['’]re speaking (?:to|with)|[Ss]peaking (?:to|with))\\s+${NAME_PART}`, 'u'),
  new RegExp(`^\\s*(?<name>(?:(?:[Dd]octor|[Dd]r|[Mm]r|[Mm]rs|[Mm]s|[Mm]iss|[Pp]rof(?:essor)?)\\.?\\s+)[\\p{Lu}][\\p{L}'’\\-]+)`, 'u'),
  new RegExp(`\\b${NAME_PART}\\s+here\\b`, 'u'),
];

/** Map cluster label → { name, evidence: [utterance ids], said } from the speaker's own words. */
export function detectSelfIntroductions(utterances, { ownerName = null } = {}, out = new Map()) {
  for (const u of utterances) {
    if (!u?.speaker || !u.text) continue;
    for (const re of INTRO_PATTERNS) {
      const m = u.text.match(re);
      const candidate = m?.groups?.name;
      if (!candidate) continue;
      const name = displayName(candidate);
      if (!isValidPersonName(name, { ownerName })) continue;
      if (!out.has(u.speaker)) out.set(u.speaker, { name, evidence: [u.id], said: u.text.trim().slice(0, 120) });
      break;
    }
  }
  return out;
}

/** Does this cluster ever say the name itself? Used as a second gate before enrolment. */
export function nameMentionedIn(name, texts) {
  const bare = cleanName(name).toLowerCase().replace(TITLE, '');
  if (!bare) return false;
  const first = bare.split(' ')[0];
  return texts.some((t) => new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t ?? ''));
}

const DISPLAY_TITLES = { doctor: 'Dr.', dr: 'Dr.', mister: 'Mr.', mr: 'Mr.', mrs: 'Mrs.', missus: 'Mrs.', miss: 'Miss', professor: 'Prof.', prof: 'Prof.' };

/** Canonical display form: "Doctor Patel" and "Dr Patel" become "Dr. Patel". */
export function displayName(name) {
  const raw = cleanName(name);
  const m = raw.match(/^(doctor|dr|mister|mr|mrs|missus|miss|professor|prof)\.?\s+(\p{L}[\p{L}'’\-]*)$/iu);
  return m ? `${DISPLAY_TITLES[m[1].toLowerCase()]} ${m[2]}` : raw;
}

export const OWNER_TOKENS = new Set(['owner', 'the owner', 'me', 'myself', 'i', 'you', 'your', 'owner (me)', 'self']);
