import { getOfficialCategory } from './categoryMap.js';

/**
 * ═══════════════════════════════════════════════════════════════════
 *  LEAD FILTER  —  "SEARCH-CONTEXT AWARE" ENGINE
 * ═══════════════════════════════════════════════════════════════════
 *
 *  PHILOSOPHY:
 *  What the user searched defines what is accepted AND what is denied.
 *
 *  Search "water damage"  →  accept water damage, flood, storm, disaster
 *                            deny  mold (it's a different niche)
 *
 *  Search "mold remediation" → accept mold, mildew, IAQ, water damage
 *                               deny  fire-only companies
 *
 *  The filter does NOT rely on keyword matching in business names.
 *  Instead it uses:
 *    1. Google Maps category (most reliable)
 *    2. Raw pane text scan
 *    3. Hard-block for truly irrelevant industries (dentists, gyms, etc.)
 *    4. Trust Google as final fallback (Google already filtered results)
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Niche Definitions ───────────────────────────────────────────────────────
// Each niche has:
//   accept  — category strings that are OK to include
//   deny    — category strings that should be excluded when OTHER niches' terms appear
//   signals — words/phrases that strongly indicate this niche in raw text or name
//   blockedSignals — phrases that indicate a DIFFERENT niche (only denied if NOT in accept list)
const NICHE_PROFILES = {
  'water_damage': {
    accept: [
      'water damage restoration service', 'water damage restoration', 'water restoration',
      'flood damage restoration', 'flood restoration', 'flood service',
      'disaster restoration', 'storm damage restoration', 'storm restoration',
      'damage restoration', 'emergency restoration', 'property restoration',
      'building restoration service', 'restoration service', 'restoration company',
      'general contractor', 'construction company'  // often do water damage
    ],
    deny: [
      'mold remediation service', 'mold removal service', 'mold inspection',
      'mold testing', 'air quality', 'asbestos'
    ],
    signals: [
      'water damage', 'water restoration', 'flood', 'storm damage', 'storm restoration',
      'disaster restoration', 'emergency restoration', 'sewage', 'burst pipe',
      'leak', 'moisture', 'dehumidif', 'dry-out', 'dryout', 'water mitigation'
    ]
  },
  'mold_remediation': {
    accept: [
      'mold remediation service', 'mold removal service', 'mold inspection',
      'indoor air quality', 'water damage restoration service', // water damage causes mold
      'disaster restoration', 'property restoration', 'restoration service'
    ],
    deny: [
      'fire damage restoration service' // fire-only companies
    ],
    signals: [
      'mold', 'mould', 'mildew', 'fungus', 'spore', 'remediation', 'indoor air',
      'air quality', 'moisture'
    ]
  },
  'fire_damage': {
    accept: [
      'fire damage restoration service', 'fire restoration', 'smoke damage restoration',
      'smoke restoration', 'disaster restoration', 'building restoration service',
      'property restoration', 'restoration service', 'restoration company',
      'general contractor'
    ],
    deny: [],
    signals: [
      'fire damage', 'fire restoration', 'smoke damage', 'smoke restoration',
      'soot', 'char', 'burn', 'fire and smoke', 'disaster'
    ]
  },
  'flood_damage': {
    accept: [
      'flood damage restoration', 'flood restoration', 'water damage restoration service',
      'water damage restoration', 'disaster restoration', 'storm damage restoration',
      'property restoration', 'building restoration service', 'restoration service'
    ],
    deny: [
      'mold remediation service', 'mold removal service'
    ],
    signals: [
      'flood', 'water damage', 'storm damage', 'disaster', 'emergency restoration',
      'sewage backup', 'burst pipe', 'basement flooding'
    ]
  },
  'disaster_restoration': {
    accept: [
      'disaster restoration', 'building restoration service', 'water damage restoration service',
      'fire damage restoration service', 'flood damage restoration',
      'storm damage restoration', 'property restoration', 'restoration service',
      'general contractor'
    ],
    deny: [],
    signals: [
      'disaster', 'emergency', 'storm', 'flood', 'fire', 'water damage',
      'catastrophe', 'property restoration', 'full restoration'
    ]
  },
  'storm_damage': {
    accept: [
      'storm damage restoration', 'disaster restoration', 'roofing contractor',
      'water damage restoration service', 'flood damage restoration',
      'building restoration service', 'general contractor', 'restoration service'
    ],
    deny: [],
    signals: [
      'storm', 'hail', 'wind damage', 'tornado', 'hurricane', 'tree damage',
      'roof damage', 'water intrusion', 'flood'
    ]
  }
};

// ─── Absolute Block Industries (NEVER relevant to property restoration) ───────
// Multi-word phrases only — prevents substring false positives
const ABSOLUTE_BLOCKS = [
  'dentist', 'dental clinic', 'dental office', 'orthodontist',
  'veterinarian', 'animal hospital',
  'yoga studio', 'fitness center', 'CrossFit',
  'day spa', 'nail salon', 'hair salon', 'beauty salon', 'barbershop',
  'massage therapy', 'massage parlor',
  'restaurant', 'fast food', 'bakery', 'cafe', 'coffee shop', 'night club', 'catering service',
  'clothing store', 'jewelry store', 'antique shop', 'thrift store', 'pawn shop',
  'insurance agent', 'real estate agent', 'real estate agency', 'mortgage broker',
  'law firm', 'accountant', 'cpa firm',
  'computer repair', 'phone repair', 'cell phone repair',
  'landscaping company', 'lawn care service', 'lawn mowing',
  'pool cleaning', 'pool service',
  'towing service', 'roadside assistance',
  'pest control',
  'appliance repair',
  'car wash', 'auto repair shop', 'auto body shop', 'car dealer', 'tire shop'
];

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Match a niche keyword string to one of our niche profiles */
function getNicheProfile(keyword) {
  const kw = normalize(keyword);
  if (kw.includes('mold') || kw.includes('mould') || kw.includes('remediation')) return NICHE_PROFILES['mold_remediation'];
  if (kw.includes('fire') || kw.includes('smoke')) return NICHE_PROFILES['fire_damage'];
  if (kw.includes('flood')) return NICHE_PROFILES['flood_damage'];
  if (kw.includes('storm') || kw.includes('hail') || kw.includes('wind damage')) return NICHE_PROFILES['storm_damage'];
  if (kw.includes('disaster')) return NICHE_PROFILES['disaster_restoration'];
  if (kw.includes('water') || kw.includes('damage') || kw.includes('restoration')) return NICHE_PROFILES['water_damage'];
  return null; // unknown niche → use generic fallback
}

/** Hard-block: returns the blocked term if hit, else null */
function isAbsoluteBlock(text, keywordLower) {
  const t = normalize(text);
  for (const term of ABSOLUTE_BLOCKS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(t) && !keywordLower.includes(normalize(term))) {
      return term;
    }
  }
  return null;
}

/**
 * Main classifier.
 * lead.categories = [googleCategory, sidePaneText, feedCardText]
 */
export function classifyLead(lead, keyword, exactMatch = false) {
  const name          = normalize(lead.name || '');
  const googleCat     = normalize((lead.categories || [])[0] || '');
  const sidePaneText  = normalize((lead.categories || [])[1] || '').slice(0, 3000);
  const feedCardText  = normalize((lead.categories || [])[2] || '').slice(0, 500);
  const keywordLower  = normalize(keyword || '');
  const fullText      = `${name} ${googleCat} ${sidePaneText} ${feedCardText}`;

  const officialCat = getOfficialCategory(keyword);
  const targetName  = normalize(officialCat.name);
  const profile     = getNicheProfile(keyword);

  // ── STEP 1: ABSOLUTE HARD-BLOCK ──────────────────────────────────────────────
  // Check name + google category only (not full text — avoids false positives from reviews)
  const blockHit = isAbsoluteBlock(`${name} ${googleCat}`, keywordLower);
  if (blockHit) {
    return { status: 'TRASH', reason: `Irrelevant industry blocked: "${blockHit}"` };
  }

  // ── STEP 2: NICHE-SPECIFIC DENY LIST ─────────────────────────────────────────
  // If we have a profile and the Google category is explicitly in the deny list,
  // this business belongs to a DIFFERENT niche the user didn't ask for.
  if (profile && googleCat && googleCat.length > 3) {
    const isDenied = profile.deny.some(d => {
      const dn = normalize(d);
      return googleCat.includes(dn) || dn.includes(googleCat);
    });
    if (isDenied) {
      return { status: 'TRASH', reason: `Category "${googleCat}" is a different niche — not related to "${keyword}"` };
    }
  }

  // ── STEP 3: GOOGLE CATEGORY MATCH (most reliable signal) ──────────────────────
  if (googleCat && googleCat.length > 3) {
    // Check against profile accept list
    if (profile) {
      const isAccepted = profile.accept.some(a => {
        const an = normalize(a);
        return googleCat.includes(an) || an.includes(googleCat);
      });
      if (isAccepted) {
        return { status: 'KEEP', reason: `Google category accepted: "${googleCat}"` };
      }
    }

    // Also check against the officialCat's own aliases/accepted
    const officialAccepted = [
      targetName,
      ...(officialCat.aliases || []).map(a => normalize(a)),
      ...(officialCat.acceptedCategories || []).map(a => normalize(a)),
      ...(officialCat.relatedCategories || []).map(a => normalize(a))
    ];
    const isOfficialMatch = officialAccepted.some(a => a.length > 3 && (googleCat.includes(a) || a.includes(googleCat)));
    if (isOfficialMatch) {
      return { status: 'KEEP', reason: `Google category matched official definition: "${googleCat}"` };
    }
  }

  // ── STEP 4: NICHE SIGNAL WORDS IN NAME OR PANE TEXT ──────────────────────────
  if (profile) {
    // Check niche signals against the NAME first
    const nameHasSignal = profile.signals.some(s => name.includes(normalize(s)));
    if (nameHasSignal) {
      return { status: 'KEEP', reason: `Business name contains niche signal for "${keyword}"` };
    }

    // Check niche signals in raw pane/feed text (broad scan)
    const textHasSignal = profile.signals.some(s => {
      const sn = normalize(s);
      return sn.length > 4 && (sidePaneText.includes(sn) || feedCardText.includes(sn));
    });
    if (textHasSignal) {
      return { status: 'KEEP', reason: `Niche signal found in page content for "${keyword}"` };
    }

    // Check if the niche's accept-list categories appear anywhere in raw text
    const textHasAcceptedCat = profile.accept.some(a => {
      const an = normalize(a);
      return an.length > 5 && (sidePaneText.includes(an) || feedCardText.includes(an));
    });
    if (textHasAcceptedCat) {
      return { status: 'KEEP', reason: `Accepted category phrase found in page text` };
    }
  }

  // Generic fallback: any restoration-adjacent keyword in name
  const genericRestorationWords = [
    'restoration', 'remediation', 'damage', 'flood', 'mold', 'water damage',
    'fire damage', 'smoke', 'emergency service', 'disaster', 'cleanup',
    'structural', 'reconstruct', 'dehumidif', 'sewage', 'drywall', 'biohazard'
  ];
  const nameHasGenericSignal = genericRestorationWords.some(w => name.includes(normalize(w)));
  if (nameHasGenericSignal) {
    return { status: 'KEEP', reason: `Business name signals property restoration trade` };
  }

  // ── STEP 5: TRUST GOOGLE (final fallback) ─────────────────────────────────────
  // Google returned this for our specific search query.
  // If no hard-block hit and no niche deny hit, default to KEEP.
  // This only applies when Google gave us NO category (blank category = no signal).
  if (!googleCat) {
    return { status: 'KEEP', reason: `No category data — trusting Google's search relevance` };
  }

  // If Google DID give us a category but it didn't match anything, reject cleanly
  return { status: 'TRASH', reason: `Google category "${googleCat}" is not related to "${keyword}"` };
}

export function classifyBatch(leads, keyword, exactMatch = false) {
  const results = leads.map(lead => classifyLead(lead, keyword, exactMatch));
  const keptCount = results.filter(r => r.status === 'KEEP').length;
  console.log(`[Filter] ${keptCount}/${leads.length} kept for "${keyword}"`);
  return results;
}
