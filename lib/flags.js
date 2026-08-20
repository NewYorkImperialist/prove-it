"use strict";
// ISO 3166-1 alpha-2 codes (lowercase, matching flagcdn.com's URL scheme) for every country
// that appears in a "Countries of/in ..." category — the source data for the Flags quizzes
// (lib/solo-catalog.js's FLAG_CATS). Keyed by every alias those categories use, not just the
// display name, since the display name itself differs between lists for a couple of countries
// (e.g. "Democratic Republic of the Congo" in the world list vs. "DR Congo" in the Africa one).
const COUNTRY_CODES = {
  afghanistan: "af", albania: "al", algeria: "dz", andorra: "ad", angola: "ao",
  "antigua and barbuda": "ag", antigua: "ag", argentina: "ar", armenia: "am",
  australia: "au", austria: "at", azerbaijan: "az", bahamas: "bs", "the bahamas": "bs",
  bahrain: "bh", bangladesh: "bd", barbados: "bb", belarus: "by", belgium: "be",
  belize: "bz", benin: "bj", bhutan: "bt", bolivia: "bo",
  "bosnia and herzegovina": "ba", bosnia: "ba", botswana: "bw", brazil: "br", brunei: "bn",
  bulgaria: "bg", "burkina faso": "bf", burundi: "bi", "cabo verde": "cv", "cape verde": "cv",
  cambodia: "kh", cameroon: "cm", canada: "ca", "central african republic": "cf", car: "cf",
  chad: "td", chile: "cl", china: "cn", colombia: "co", comoros: "km",
  "republic of the congo": "cg", congo: "cg", "congo-brazzaville": "cg", "congo brazzaville": "cg",
  "costa rica": "cr", croatia: "hr", cuba: "cu", cyprus: "cy", czechia: "cz", "czech republic": "cz",
  "democratic republic of the congo": "cd", "democratic republic of congo": "cd", drc: "cd",
  "dr congo": "cd", "congo-kinshasa": "cd", "congo kinshasa": "cd", rdc: "cd",
  denmark: "dk", djibouti: "dj", dominica: "dm", "dominican republic": "do", dr: "do",
  ecuador: "ec", egypt: "eg", "el salvador": "sv", "equatorial guinea": "gq", eritrea: "er",
  estonia: "ee", eswatini: "sz", swaziland: "sz", ethiopia: "et", fiji: "fj", finland: "fi",
  france: "fr", gabon: "ga", gambia: "gm", "the gambia": "gm", georgia: "ge", germany: "de",
  ghana: "gh", greece: "gr", grenada: "gd", guatemala: "gt", guinea: "gn",
  "guinea-bissau": "gw", "guinea bissau": "gw", guyana: "gy", haiti: "ht", honduras: "hn",
  hungary: "hu", iceland: "is", india: "in", indonesia: "id", iran: "ir", iraq: "iq",
  ireland: "ie", israel: "il", italy: "it", "ivory coast": "ci", "cote d'ivoire": "ci",
  "cote divoire": "ci", "côte d'ivoire": "ci", jamaica: "jm", japan: "jp", jordan: "jo",
  kazakhstan: "kz", kenya: "ke", kiribati: "ki", kosovo: "xk", kuwait: "kw", kyrgyzstan: "kg",
  laos: "la", latvia: "lv", lebanon: "lb", lesotho: "ls", liberia: "lr", libya: "ly",
  liechtenstein: "li", listhenstein: "li", listenshtein: "li", lictenshtein: "li",
  lithuania: "lt", luxembourg: "lu", madagascar: "mg", malawi: "mw", malaysia: "my",
  maldives: "mv", mali: "ml", malta: "mt", "marshall islands": "mh", marshalls: "mh",
  mauritania: "mr", mauritius: "mu", mexico: "mx", micronesia: "fm",
  "federated states of micronesia": "fm", fsm: "fm", moldova: "md", monaco: "mc",
  mongolia: "mn", montenegro: "me", morocco: "ma", mozambique: "mz", myanmar: "mm", burma: "mm",
  namibia: "na", nauru: "nr", nepal: "np", netherlands: "nl", "new zealand": "nz",
  nicaragua: "ni", niger: "ne", nigeria: "ng", "north korea": "kp", dprk: "kp",
  "north macedonia": "mk", macedonia: "mk", norway: "no", oman: "om", pakistan: "pk",
  palau: "pw", palestine: "ps", "palestinian territories": "ps", "state of palestine": "ps",
  panama: "pa", "papua new guinea": "pg", paraguay: "py", peru: "pe", philippines: "ph",
  poland: "pl", portugal: "pt", qatar: "qa", romania: "ro", russia: "ru",
  "russian federation": "ru", rwanda: "rw", "saint kitts and nevis": "kn",
  "st kitts and nevis": "kn", "st kitts": "kn", "saint lucia": "lc", "st lucia": "lc",
  "saint vincent and the grenadines": "vc", "st vincent": "vc", samoa: "ws", "san marino": "sm",
  "sao tome and principe": "st", "sao tome": "st", "são tomé and príncipe": "st",
  "saudi arabia": "sa", saudi: "sa", senegal: "sn", serbia: "rs", seychelles: "sc",
  "sierra leone": "sl", singapore: "sg", slovakia: "sk", slovenia: "si",
  "solomon islands": "sb", somalia: "so", "south africa": "za", "south korea": "kr",
  korea: "kr", "south sudan": "ss", spain: "es", "sri lanka": "lk", sudan: "sd",
  suriname: "sr", sweden: "se", switzerland: "ch", syria: "sy", taiwan: "tw",
  tajikistan: "tj", tanzania: "tz", thailand: "th", "timor-leste": "tl", "east timor": "tl",
  togo: "tg", tonga: "to", "trinidad and tobago": "tt", trinidad: "tt", tunisia: "tn",
  turkey: "tr", turkiye: "tr", turkmenistan: "tm", tuvalu: "tv", uganda: "ug", ukraine: "ua",
  "united arab emirates": "ae", uae: "ae", "united kingdom": "gb", uk: "gb", britain: "gb",
  "great britain": "gb", england: "gb", scotland: "gb", wales: "gb", "united states": "us",
  usa: "us", america: "us", "united states of america": "us", uruguay: "uy",
  uzbekistan: "uz", vanuatu: "vu", "vatican city": "va", vatican: "va", "holy see": "va",
  venezuela: "ve", vietnam: "vn", yemen: "ye", zambia: "zm", zimbabwe: "zw",
  "french guiana": "gf",
};

// A category entry's flag code: the first of its aliases (already norm()-ed by buildCat) that
// has a known ISO code. null if none of them match — the caller should drop that entry rather
// than show a broken image.
function flagCodeFor(entry) {
  for (const a of entry.aliases) if (COUNTRY_CODES[a]) return COUNTRY_CODES[a];
  return null;
}

// flagcdn.com hotlinks freely (no key, no attribution required) and serves every ISO code as a
// clean SVG, which scales to any grid-cell size without a stored asset on our side.
const flagUrl = (code) => `https://flagcdn.com/${code}.svg`;

// The Flags quizzes: "Flags of the World" plus one per continent, each sharing its entries with
// the matching "Countries in ..." category. The single source of truth for which quizzes exist —
// lib/solo-catalog.js (client catalogue) and lib/category-data.js (server round validation) both
// derive from this instead of each keeping their own list.
const FLAG_SOURCE = [
  ["Countries of the World", "Flags of the World"],
  ["Countries in Africa", "Flags of Africa"],
  ["Countries in Asia", "Flags of Asia"],
  ["Countries in Europe", "Flags of Europe"],
  ["Countries in North America", "Flags of North America"],
  ["Countries in South America", "Flags of South America"],
  ["Countries in Oceania", "Flags of Oceania"],
];
const FLAG_CAT_NAMES = new Set(FLAG_SOURCE.map(([, flagName]) => flagName));

module.exports = { COUNTRY_CODES, flagCodeFor, flagUrl, FLAG_SOURCE, FLAG_CAT_NAMES };
