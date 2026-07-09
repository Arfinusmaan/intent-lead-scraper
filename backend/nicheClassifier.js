// =============================================================================
// NICHE INTELLIGENCE ENGINE v2 — Entity Classification System
// =============================================================================
// Inputs per business:
//   name, category, sidePaneText, services, reviewsText, websiteText
// Outputs:
//   niche_match_score    : 0–100
//   sms_ready_tier       : 'VERIFIED' | 'LIKELY' | 'REJECTED'
//   classification_status: 'accepted' | 'review' | 'rejected'
//   classification_reason: human-readable explanation
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A — RESTORATION CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Known restoration franchise brands → instant score:100
const RESTORATION_BRANDS = [
  'servpro', 'belfor', 'servicemaster', 'paul davis', 'rainbow restoration',
  'steamatic', '911 restoration', 'puroclean', 'first onsite', 'rytech',
  'lemarg', 'restoration 1', 'bnr restoration', 'restorationmaster',
  'jenkins restorations', 'criticare', 'midwest restoration', 'blackmon mooring',
  'bms cat', 'chemdry', 'blusky', 'polygon group', 'dki services',
  'afterdisaster', 'r3 restoration', 'rms restoration',
];

// Hard-reject name fragments — unconditional rejection regardless of any positive signals
const HARD_REJECT_NAME_FRAGMENTS = [
  // Automotive
  'auto restoration', 'car restoration', 'classic car', 'automobile restoration',
  'vehicle restoration', 'motorcycle restoration', 'boat restoration',
  'auto body', 'collision repair', 'transmission',
  // Musical instruments
  'guitar restoration', 'guitar repair', 'piano restoration', 'piano repair',
  'instrument restoration', 'instrument repair', 'violin restoration',
  'banjo restoration', 'trumpet restoration', 'drum restoration',
  // Furniture / antiques / art
  'furniture restoration', 'furniture repair', 'wood restoration',
  'cabinet restoration', 'antique restoration', 'art restoration',
  'painting restoration', 'canvas restoration', 'photo restoration',
  'photograph restoration', 'picture restoration',
  // Personal care
  'hair restoration', 'hair transplant', 'nail restoration', 'dental restoration',
  'tooth restoration', 'teeth restoration', 'smile restoration',
  // Historic / architectural
  'historic restoration', 'historical restoration', 'monument restoration',
  'masonry restoration', 'brick restoration', 'stucco restoration',
  // Electronics
  'phone restoration', 'computer restoration', 'electronics restoration',
  // Other clearly wrong
  'faith restoration', 'church restoration', 'relationship restoration',
  'eco restoration', 'ecological restoration', 'habitat restoration', 'ecosystem restoration',
];

// Hard-reject GBP categories
const HARD_REJECT_CATEGORY_EXACT = [
  'auto body shop', 'auto repair shop', 'car repair', 'automobile dealer',
  'motorcycle dealer', 'motorcycle repair',
  'musical instrument store', 'guitar store', 'music school',
  'antique store', 'antique furniture store', 'art gallery',
  'furniture store', 'furniture repair shop',
  'hair salon', 'nail salon', 'dental clinic', 'dentist', 'orthodontist',
  'hair restoration service',
  'restaurant', 'hotel', 'bed & breakfast', 'bakery', 'brewery', 'coffee shop',
  'gym', 'yoga studio', 'fitness center',
  'real estate agency', 'property management company',
  'school', 'university', 'church', 'non-profit organization',
  'farm', 'agricultural service', 'tree service', 'lawn care service',
];

// Adjacent industries — can legitimately do restoration; require deeper checks
const ADJACENT_PRIMARY_CATEGORIES = [
  'cleaning service', 'carpet cleaner', 'janitorial service',
  'pressure washing service', 'house cleaning service', 'commercial cleaning service',
  'plumber', 'plumbing service', 'plumbing contractor',
  'general contractor', 'construction company', 'home improvement',
  'handyman', 'hvac contractor', 'electrician',
  'roofing contractor', 'roofing company',
  'disaster recovery service',
  'property maintenance',
];

// DNA clusters: each keyword in a cluster earns weighted score
const RESTORATION_CLUSTERS = {
  WATER: {
    weight: 30,
    keywords: [
      'water damage', 'water extraction', 'water removal', 'water intrusion',
      'flood damage', 'flood cleanup', 'flood restoration', 'flood water removal',
      'basement flooding', 'burst pipe', 'pipe burst', 'sewage backup',
      'sewage cleanup', 'sewage removal', 'structural drying', 'moisture detection',
      'dehumidification', 'drying service', 'water mitigation', 'water loss',
      'wet carpet', 'subfloor drying', 'crawl space drying', 'water intrusion',
    ],
  },
  FIRE: {
    weight: 25,
    keywords: [
      'fire damage', 'fire restoration', 'fire cleanup', 'fire and smoke',
      'smoke damage', 'smoke cleanup', 'smoke odor', 'odor removal',
      'soot removal', 'char removal', 'burn damage', 'fire loss',
      'content cleaning', 'board up service', 'tarping service', 'fire mitigation',
    ],
  },
  MOLD: {
    weight: 20,
    keywords: [
      'mold remediation', 'mold removal', 'mold inspection', 'mold testing',
      'mold damage', 'mold cleanup', 'black mold', 'toxic mold',
      'mildew removal', 'fungal remediation', 'air quality testing',
      'moisture barrier', 'mycotoxin',
    ],
  },
  EMERGENCY: {
    weight: 15,
    keywords: [
      '24/7', '24 hours', 'emergency service', 'emergency response',
      'emergency restoration', 'rapid response', 'immediate response',
      'on call', 'storm damage', 'storm restoration', 'hurricane damage',
      'tornado damage', 'disaster restoration', 'disaster recovery',
      'catastrophe', 'loss mitigation',
    ],
  },
  INSURANCE: {
    weight: 10,
    keywords: [
      'insurance claim', 'insurance restoration', 'insurance work',
      'iicrc', 'iicrc certified', 'iicrc trained', 'water loss claim',
      'works with insurance', 'direct billing', 'direct insurance billing',
      'adjuster', 'claims specialist',
    ],
  },
};

// ─── TIER 1: Perfect GBP category matches → instant score:100, no further checks needed
const GBP_TIER1_CATEGORIES = [
  'damage restoration service',
  'water damage restoration service',
  'fire damage restoration service',
  'mold remediation service',
  'water damage restoration',
  'fire damage restoration',
  'mold remediation',
  'flood restoration service',
  'flood damage restoration',
];

// ─── PRIMARY RESTORATION CATEGORIES (Change 2)
// These are authoritative Google-assigned restoration categories.
// They receive a +70 base score immediately, then CONTINUE accumulating
// cluster/services/review signals — so a verified category + strong signals = VERIFIED.
// Do NOT treat like adjacent categories — no multi-cluster gate applies.
const PRIMARY_RESTORATION_CATEGORIES = [
  'water damage restoration service',  // also in Tier 1, handled first
  'fire damage restoration service',
  'flood restoration service',
  'damage restoration service',
  'building restoration service',
  'disaster restoration service',
  'mold remediation service',
  'restoration service',
  'fire restoration service',
  'smoke damage restoration service',
  'storm damage restoration service',
  'environmental remediation',
  'remediation service',
  'water mitigation service',
  'biohazard remediation service',
  'crime scene cleanup service',
];

// ─── PRIMARY RESTORATION CONFIDENCE SIGNALS
// Used after PRIMARY category match to push score toward VERIFIED.
const PRIMARY_CONFIDENCE_SIGNALS = [
  'water extraction', 'water mitigation', 'water damage', 'flood cleanup',
  'fire damage', 'smoke damage', 'storm damage', 'mold remediation', 'mold removal',
  'sewage cleanup', 'structural drying', 'iicrc', 'insurance claim', '24/7 emergency service',
  'emergency response', 'disaster recovery', 'dehumidification', 'moisture detection',
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B — REVIEW SENTIMENT SCORER (Item 3)
// Analyses GBP review text for positive/negative restoration signals.
// Returns a score delta: positive = real restoration company,
// negative = wrong industry confirmed through customer language.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW_POSITIVE_SIGNALS = [
  'flood', 'flooded', 'flooding', 'basement flood', 'pipe burst', 'pipe broke',
  'water leak', 'water damage', 'water in my', 'water in our',
  'mold', 'mold problem', 'black mold',
  'fire damage', 'smoke damage', 'after the fire',
  'insurance claim', 'insurance company', 'worked with insurance',
  'emergency', 'called at', 'called them at', 'same day', 'came out fast',
  'drying equipment', 'dehumidifier', 'moisture', 'dryout', 'dry out',
  'mitigation', 'remediation',
];

const REVIEW_NEGATIVE_SIGNALS = [
  'car restoration', 'guitar', 'instrument', 'furniture restoration',
  'antique', 'photo restoration', 'painting restoration',
  'auto body', 'collision',
];

/**
 * Score a business's GBP reviews for restoration relevance.
 * @param {string} reviewsText — concatenated raw review text from GBP
 * @returns {number} delta score: -30 to +25
 */
export function scoreReviews(reviewsText) {
  if (!reviewsText || reviewsText.length < 20) return 0;
  const text = reviewsText.toLowerCase();

  let positiveHits = REVIEW_POSITIVE_SIGNALS.filter(kw => text.includes(kw)).length;
  let negativeHits = REVIEW_NEGATIVE_SIGNALS.filter(kw => text.includes(kw)).length;

  if (negativeHits > 0) return -30; // Reviews confirm wrong industry
  if (positiveHits >= 4) return 25;
  if (positiveHits >= 2) return 15;
  if (positiveHits === 1) return 8;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C — SMS_READY TIER (Change 1)
// Only VERIFIED and LIKELY are considered SMS-ready for outreach.
// NEEDS_ENRICHMENT removed — anything below 60 is REJECTED.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a 0-100 niche_match_score to an SMS-ready outreach tier.
 * @param {number} score
 * @returns {'VERIFIED'|'LIKELY'|'REJECTED'}
 */
export function getSmsReadyTier(score) {
  if (score >= 80) return 'VERIFIED';
  if (score >= 60) return 'LIKELY';
  return 'REJECTED';
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION D — CORE RESTORATION CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies a business as a property damage restoration company.
 *
 * @param {string} businessName
 * @param {string} category      — GBP primary category
 * @param {string} sidePaneText  — Full Maps side panel text
 * @param {string} [services]    — GBP services list text
 * @param {string} [reviewsText] — Concatenated GBP review text
 * @param {string} [websiteText] — Body text of business website
 * @returns {{ score: number, reason: string, status: 'accepted'|'review'|'rejected', sms_ready_tier: string }}
 */
export function classifyRestoration(businessName, category, sidePaneText, services = '', reviewsText = '', websiteText = '') {
  const name  = (businessName || '').toLowerCase().trim();
  const cat   = (category     || '').toLowerCase().trim();
  const pane  = (sidePaneText || '').toLowerCase();
  const svc   = (services     || '').toLowerCase();
  const rev   = (reviewsText  || '').toLowerCase();
  const web   = (websiteText  || '').toLowerCase();

  // Build unified corpus — name/category weighted higher via repetition
  const corpus = `${name} ${name} ${cat} ${cat} ${pane} ${svc} ${rev} ${web}`;

  const reasons = [];
  let score = 0;

  // ── STEP 0: BRAND SHORTCUT ─────────────────────────────────────────────────
  const matchedBrand = RESTORATION_BRANDS.find(b => name.includes(b) || pane.includes(b));
  if (matchedBrand) {
    const tier = getSmsReadyTier(100);
    return { score: 100, reason: `Known restoration franchise: "${matchedBrand}"`, status: 'accepted', sms_ready_tier: tier };
  }

  // ── STEP 1: HARD REJECT BY NAME ────────────────────────────────────────────
  const nameReject = HARD_REJECT_NAME_FRAGMENTS.find(f => name.includes(f));
  if (nameReject) {
    return { score: 0, reason: `Hard-rejected: name contains "${nameReject}"`, status: 'rejected', sms_ready_tier: 'REJECTED' };
  }

  // ── STEP 2: HARD REJECT BY GBP CATEGORY ───────────────────────────────────
  if (cat.length > 1) {
    const catReject = HARD_REJECT_CATEGORY_EXACT.find(f => cat.includes(f));
    if (catReject) {
      return { score: 0, reason: `Hard-rejected: category "${cat}" → "${catReject}"`, status: 'rejected', sms_ready_tier: 'REJECTED' };
    }
  }

  // ── STEP 3: GBP CATEGORY SCORING ──────────────────────────────────────────
  // Three tracks:
  //   Tier 1 → instant accept at score:100 (perfect GBP match)
  //   Primary → +70 base, then continue to cluster/review scoring (Change 2)
  //   Adjacent → 0 base, must prove via ≥2 clusters (Change 3, unchanged)
  let categoryBonus = 0;
  let isPrimaryRestoration = false; // true = skip adjacent gate entirely

  if (cat.length > 1) {
    // ── Tier 1: Perfect matches → instant return ──────────────────────────────
    const isTier1 = GBP_TIER1_CATEGORIES.some(k => cat.includes(k));
    if (isTier1) {
      reasons.push(`Tier-1 GBP category: "${cat}"`);
      // Still accumulate extra confidence below before returning
      categoryBonus = 100;
    }

    // ── Primary restoration category → +70 base, continue scoring ───────────
    if (!isTier1) {
      const matchedPrimary = PRIMARY_RESTORATION_CATEGORIES.find(k => cat.includes(k));
      if (matchedPrimary) {
        categoryBonus = 70;
        isPrimaryRestoration = true;
        reasons.push(`Primary restoration category: "${cat}" (+70 base)`);
      }
    } else {
      isPrimaryRestoration = true; // Tier-1 also bypasses adjacent gate
    }

    // ── Non-matching category: check adjacent or reject ───────────────────────
    if (categoryBonus === 0) {
      const isAdjacent = ADJACENT_PRIMARY_CATEGORIES.some(adj => cat.includes(adj));
      if (!isAdjacent) {
        return { score: 5, reason: `Category "${cat}" is not restoration or adjacent`, status: 'rejected', sms_ready_tier: 'REJECTED' };
      }
      reasons.push(`Adjacent category "${cat}" — deeper check required`);
    }

    score += categoryBonus;

    // Tier-1 with no extra signals → return immediately at 100
    if (isTier1 && score === 100) {
      return { score: 100, reason: reasons.join('; '), status: 'accepted', sms_ready_tier: 'VERIFIED' };
    }
  }

  // ── STEP 4: DNA CLUSTER SCORING ────────────────────────────────────────────
  const matchedClusters = [];
  for (const [clusterName, clusterDef] of Object.entries(RESTORATION_CLUSTERS)) {
    const hits = clusterDef.keywords.filter(kw => corpus.includes(kw));
    if (hits.length > 0) {
      const clusterScore = Math.round(
        Math.min(clusterDef.weight, clusterDef.weight * (1 - Math.exp(-hits.length * 0.6)))
      );
      score += clusterScore;
      matchedClusters.push(clusterName);
      reasons.push(`${clusterName}[${hits.slice(0, 2).join(',')}]`);
    }
  }

  // ── STEP 5: MULTI-CLUSTER BONUS ────────────────────────────────────────────
  if (matchedClusters.length >= 3) {
    score += 20;
    reasons.push(`Multi-cluster ×${matchedClusters.length} +20`);
  } else if (matchedClusters.length === 2) {
    score += 10;
    reasons.push(`Dual-cluster +10`);
  } else if (matchedClusters.length === 1 && categoryBonus === 0) {
    score = Math.min(score, 35);
    reasons.push(`Single cluster, no category → capped 35`);
  }

  // ── STEP 6: ADJACENT INDUSTRY GATE (Change 3 — unchanged logic) ───────────
  // Only applies to truly adjacent categories (plumber, carpet cleaner, etc.)
  // Primary restoration categories (isPrimaryRestoration=true) bypass this gate entirely.
  if (!isPrimaryRestoration && categoryBonus === 0 && cat.length > 1) {
    const isAdjacent = ADJACENT_PRIMARY_CATEGORIES.some(adj => cat.includes(adj));
    if (isAdjacent && matchedClusters.length < 2) {
      return {
        score: Math.min(score, 30),
        reason: `Adjacent "${cat}" needs ≥2 clusters (has ${matchedClusters.length})`,
        status: 'rejected',
        sms_ready_tier: 'REJECTED',
      };
    }
    if (isAdjacent) reasons.push(`Adjacent OK — ≥2 clusters`);
  }

  // ── STEP 6b: PRIMARY CATEGORY CONFIDENCE BOOST ────────────────────────────
  // After a primary restoration category match, scan corpus for confirmation signals.
  // Each signal hit adds +3 (capped at +15 total) pushing toward VERIFIED tier.
  if (isPrimaryRestoration && cat.length > 1) {
    const confidenceHits = PRIMARY_CONFIDENCE_SIGNALS.filter(sig => corpus.includes(sig));
    if (confidenceHits.length > 0) {
      const boost = Math.min(15, confidenceHits.length * 3);
      score += boost;
      reasons.push(`Primary confidence signals[${confidenceHits.slice(0, 3).join(',')}] +${boost}`);
    }
  }

  // ── STEP 7: REVIEW SENTIMENT BONUS ────────────────────────────────────────
  if (rev.length > 20) {
    const reviewDelta = scoreReviews(rev);
    if (reviewDelta !== 0) {
      score += reviewDelta;
      reasons.push(`Reviews delta: ${reviewDelta > 0 ? '+' : ''}${reviewDelta}`);
    }
  }

  // ── STEP 8: NORMALIZE + CLASSIFY ──────────────────────────────────────────
  score = Math.min(100, Math.max(0, Math.round(score)));

  let status;
  if (score >= 55) status = 'accepted';
  else if (score >= 30) status = 'review';
  else status = 'rejected';

  const sms_ready_tier = getSmsReadyTier(score);

  return {
    score,
    reason: reasons.length > 0 ? reasons.join('; ') : 'No restoration signals found',
    status,
    sms_ready_tier,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION E — POST-WEBSITE RE-CLASSIFICATION (Item 1)
// Called after website crawl completes to upgrade or downgrade a lead.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-runs classification after website text is available.
 * Merges new result with original — upgrades score if website confirms niche,
 * downgrades / removes if website proves wrong industry.
 *
 * @param {string} niche
 * @param {object} lead          — existing lead object with classification fields
 * @param {string} websiteText   — body text from website crawl
 * @returns {{ upgraded: boolean, downgraded: boolean, purge: boolean, updated: object }}
 */
export function reclassifyWithWebsite(niche, lead, websiteText) {
  const n = (niche || '').toLowerCase();
  const isRestoration =
    n.includes('restoration') || n.includes('water damage') || n.includes('fire damage') ||
    n.includes('mold') || n.includes('flood') || n.includes('remediation') ||
    n.includes('mitigation') || n.includes('smoke damage') || n.includes('storm damage') ||
    n.includes('disaster') || n.includes('sewage') || n.includes('property damage');

  if (!isRestoration) {
    // Only reclassification for restoration niche currently
    return { upgraded: false, downgraded: false, purge: false, updated: lead };
  }

  // Check website text for hard wrong-industry signals
  const webLower = (websiteText || '').toLowerCase();
  const wrongIndustryWebSignals = [
    'guitar restoration', 'auto restoration', 'car restoration', 'furniture restoration',
    'antique restoration', 'art restoration', 'photo restoration',
    'piano restoration', 'instrument repair',
  ];
  const webWrongMatch = wrongIndustryWebSignals.find(s => webLower.includes(s));
  if (webWrongMatch) {
    return {
      upgraded: false, downgraded: true, purge: true,
      updated: { ...lead, classification_status: 'rejected', niche_match_score: 0, sms_ready_tier: 'REJECTED',
        classification_reason: `Website confirmed wrong industry: "${webWrongMatch}"` },
    };
  }

  // Run full reclassification with website text included
  const fresh = classifyRestoration(
    lead.business_name, lead.category || '', lead.sidePaneText || '',
    lead.services || '', lead.reviews_text || '', websiteText
  );

  const prevScore = lead.niche_match_score || 0;
  const upgraded = fresh.score > prevScore + 5;
  const downgraded = fresh.score < prevScore - 5;
  const purge = fresh.status === 'rejected' && lead.classification_status !== 'rejected';

  const updated = {
    ...lead,
    niche_match_score: fresh.score,
    classification_status: fresh.status,
    classification_reason: fresh.reason + ' [web-reclassified]',
    sms_ready_tier: fresh.sms_ready_tier,
  };

  return { upgraded, downgraded, purge, updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION F — OTHER NICHE CLASSIFIERS
// ─────────────────────────────────────────────────────────────────────────────

export function classifyMedSpa(businessName, category, sidePaneText) {
  const name = (businessName || '').toLowerCase();
  const cat  = (category     || '').toLowerCase();
  const text = (sidePaneText || '').toLowerCase();

  const REJECT = ['massage parlour', 'massage therapist', 'thai massage', 'foot massage', 'reflexology', 'nail salon', 'barber', 'chiropractor'];
  const rejectMatch = REJECT.find(r => cat.includes(r) || name.includes(r));
  if (rejectMatch) return { score: 0, reason: `Rejected: "${rejectMatch}"`, status: 'rejected', sms_ready_tier: 'REJECTED' };

  if (cat.includes('massage') || name.includes('massage')) {
    const medTerms = ['medical', 'med', 'aesthetic', 'laser', 'clinic', 'plastic', 'dermatology', 'skin'];
    if (!medTerms.some(t => cat.includes(t) || name.includes(t))) {
      return { score: 10, reason: 'Massage without medical signals', status: 'rejected', sms_ready_tier: 'REJECTED' };
    }
  }

  const POSITIVE = ['botox', 'filler', 'laser', 'aesthetic', 'cosmetic', 'iv therapy', 'medical spa', 'medspa', 'med spa', 'skin care clinic', 'dermatology', 'coolsculpting', 'microneedling', 'kybella', 'semaglutide', 'weight loss'];
  const hits = POSITIVE.filter(p => name.includes(p) || cat.includes(p) || text.includes(p));
  const score = Math.min(100, 50 + hits.length * 10);
  return { score, reason: hits.length > 0 ? `Med spa: ${hits.slice(0,3).join(', ')}` : 'Default accept', status: score >= 50 ? 'accepted' : 'review', sms_ready_tier: getSmsReadyTier(score) };
}

export function classifyRoofing(businessName, category) {
  const name = (businessName || '').toLowerCase();
  const cat  = (category     || '').toLowerCase();
  const REJECT = ['roof bar', 'restaurant', 'hotel', 'lounge', 'rooftop bar'];
  const rejectMatch = REJECT.find(r => name.includes(r) || cat.includes(r));
  if (rejectMatch) return { score: 0, reason: `Rejected: "${rejectMatch}"`, status: 'rejected', sms_ready_tier: 'REJECTED' };
  return { score: 75, reason: 'Roofing business — passes', status: 'accepted', sms_ready_tier: getSmsReadyTier(75) };
}

export function classifyGeneric(niche, businessName, category, sidePaneText) {
  const cleanNiche    = niche.toLowerCase().trim();
  const cleanName     = (businessName  || '').toLowerCase();
  const cleanCategory = (category      || '').toLowerCase();
  const cleanText     = (sidePaneText  || '').toLowerCase();
  const noiseWords = new Set(['in','service','services','company','and','near','me','the','of','for','a','an','agency','firm']);
  const nicheWords = cleanNiche.split(/\s+/).filter(w => w.length > 2 && !noiseWords.has(w));
  if (nicheWords.length === 0) return { score: 60, reason: 'All noise words — permissive', status: 'accepted', sms_ready_tier: getSmsReadyTier(60) };
  const nameHits = nicheWords.filter(w => cleanName.includes(w));
  const catHits  = nicheWords.filter(w => cleanCategory.includes(w));
  const textHits = nicheWords.filter(w => cleanText.includes(w));
  let score = 0;
  const reasons = [];
  if (nameHits.length > 0) { score += 50; reasons.push(`Name: ${nameHits.join(',')}`); }
  if (catHits.length > 0)  { score += 30; reasons.push(`Cat: ${catHits.join(',')}`); }
  if (textHits.length > 0 && nameHits.length === 0 && catHits.length === 0) { score += 20; reasons.push(`Text: ${textHits.slice(0,3).join(',')}`); }
  score = Math.min(100, score);
  const status = score >= 50 ? 'accepted' : score >= 25 ? 'review' : 'rejected';
  return { score, reason: reasons.join('; ') || 'No signals', status, sms_ready_tier: getSmsReadyTier(score) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION G — MASTER DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master classifier — routes to the right domain classifier.
 *
 * @param {string} niche
 * @param {string} businessName
 * @param {string} category
 * @param {string} sidePaneText
 * @param {string} [services]    — GBP services list (new)
 * @param {string} [reviewsText] — GBP reviews text (new)
 * @param {string} [websiteText] — website body text
 * @returns {{ score, reason, status, sms_ready_tier }}
 */
export function classifyBusiness(niche, businessName, category, sidePaneText, services = '', reviewsText = '', websiteText = '') {
  const n = (niche || '').toLowerCase().trim();

  if (
    n.includes('restoration') || n.includes('water damage') || n.includes('fire damage') ||
    n.includes('mold') || n.includes('flood') || n.includes('remediation') ||
    n.includes('mitigation') || n.includes('smoke damage') || n.includes('storm damage') ||
    n.includes('disaster') || n.includes('sewage') || n.includes('emergency restoration') ||
    n.includes('water extraction') || n.includes('water removal') || n.includes('property damage')
  ) {
    return classifyRestoration(businessName, category, sidePaneText, services, reviewsText, websiteText);
  }

  if (n.includes('med spa') || n.includes('medspa') || n.includes('medical spa')) {
    return classifyMedSpa(businessName, category, sidePaneText);
  }

  if (n.includes('roofing') || n.includes('roofer')) {
    return classifyRoofing(businessName, category);
  }

  return classifyGeneric(niche, businessName, category, sidePaneText);
}
