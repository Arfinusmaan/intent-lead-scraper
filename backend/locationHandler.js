// =========================
// STATE DATA (FALLBACK)
// =========================
const STATES = {
  california: ['Los Angeles','San Diego','San Jose','San Francisco','Fresno','Sacramento','Long Beach','Oakland'],
  texas: ['Houston','San Antonio','Dallas','Austin','Fort Worth','El Paso'],
  florida: ['Miami','Orlando','Tampa','Jacksonville'],
  newyork: ['New York','Buffalo','Rochester','Albany'],
};

// =========================
// STATE CODE MAP
// =========================
const STATE_CODES = {
  ca: 'california',
  tx: 'texas',
  fl: 'florida',
  ny: 'newyork'
};

// =========================
// MAIN RESOLVER
// =========================
export function resolveLocation(input) {
  if (!input) return { type: 'city', cities: [] };

  const normalized = normalize(input);

  // 🔥 HANDLE STATE CODE (CA → california)
  if (STATE_CODES[normalized]) {
    const stateName = STATE_CODES[normalized];
    return {
      type: 'state',
      state: stateName,
      cities: STATES[stateName] || []
    };
  }

  // 🔥 HANDLE FULL STATE NAME
  if (STATES[normalized]) {
    return {
      type: 'state',
      state: normalized,
      cities: STATES[normalized]
    };
  }

  // 🔥 HANDLE PARTIAL MATCH (smart)
  const match = Object.keys(STATES).find(s =>
    s.includes(normalized) || normalized.includes(s)
  );

  if (match) {
    return {
      type: 'state',
      state: match,
      cities: STATES[match]
    };
  }

  // DEFAULT → treat as city
  return {
    type: 'city',
    cities: [input.trim()]
  };
}

// =========================
// NORMALIZER
// =========================
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z]/g, '');
}