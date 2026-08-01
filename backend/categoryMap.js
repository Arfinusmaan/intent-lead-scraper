/**
 * Official Google Maps Categories Enum & Identifier Mapping
 * Translates user niches into official Google Maps category names and enum IDs.
 */

const RESTORATION_ACCEPTED = [
  'Water damage restoration service',
  'Fire damage restoration service',
  'Flood damage restoration service',
  'Mold remediation service',
  'Building restoration service'
];

const RESTORATION_RELATED = [
  'General contractor',
  'Roofing contractor',
  'Construction company',
  'Remodeling contractor',
  'Carpet cleaning service'
];

export const GOOGLE_MAPS_CATEGORIES = {
  // Restoration & Emergency Property Damage
  'water damage restoration service': { enum: 'water_damage_restoration_service', name: 'Water damage restoration service',
    aliases: ['water damage restoration', 'water restoration', 'water damage repair', 'restoration service', 'restoration company', 'damage restoration'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'water damage restoration': { enum: 'water_damage_restoration_service', name: 'Water damage restoration service',
    aliases: ['water damage restoration service', 'water restoration', 'water damage repair', 'restoration service', 'restoration company', 'damage restoration'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'fire damage restoration service': { enum: 'fire_damage_restoration_service', name: 'Fire damage restoration service',
    aliases: ['fire damage restoration', 'fire restoration', 'fire and smoke restoration', 'smoke damage restoration', 'restoration service', 'restoration company'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'fire damage restoration': { enum: 'fire_damage_restoration_service', name: 'Fire damage restoration service',
    aliases: ['fire damage restoration service', 'fire restoration', 'fire and smoke restoration', 'smoke damage restoration', 'restoration service', 'restoration company'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'mold remediation service': { enum: 'mold_remediation_service', name: 'Mold remediation service',
    aliases: ['mold remediation', 'mold removal', 'mold inspection', 'mold testing service', 'mold removal service'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'mold remediation': { enum: 'mold_remediation_service', name: 'Mold remediation service',
    aliases: ['mold remediation service', 'mold removal', 'mold inspection', 'mold testing service', 'mold removal service'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'flood damage restoration service': { enum: 'water_damage_restoration_service', name: 'Flood damage restoration service',
    aliases: ['flood damage restoration', 'flood restoration', 'water damage restoration', 'water restoration', 'restoration service', 'restoration company'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'flood damage restoration': { enum: 'water_damage_restoration_service', name: 'Flood damage restoration service',
    aliases: ['flood damage restoration service', 'flood restoration', 'water damage restoration', 'water restoration', 'restoration service', 'restoration company'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'building restoration service': { enum: 'building_restoration_service', name: 'Building restoration service',
    aliases: ['building restoration', 'restoration company', 'restoration contractor', 'disaster restoration'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },
  'disaster restoration service': { enum: 'building_restoration_service', name: 'Building restoration service',
    aliases: ['disaster restoration', 'building restoration', 'restoration company', 'restoration contractor'], acceptedCategories: RESTORATION_ACCEPTED, relatedCategories: RESTORATION_RELATED },

  // Plumbing, Roofing, HVAC & Construction Trades
  'plumber': { enum: 'plumber', name: 'Plumber', aliases: ['plumbing service', 'plumbing company', 'plumbing contractor', 'plumbing repair'] },
  'plumbing service': { enum: 'plumber', name: 'Plumber', aliases: ['plumber', 'plumbing company', 'plumbing contractor', 'plumbing repair'] },
  'roofing contractor': { enum: 'roofing_contractor', name: 'Roofing contractor',
    aliases: ['roofer', 'roofing company', 'roofing service', 'roof repair', 'roofing contractors'] },
  'roofer': { enum: 'roofing_contractor', name: 'Roofing contractor',
    aliases: ['roofing contractor', 'roofing company', 'roofing service', 'roof repair'] },
  'hvac contractor': { enum: 'hvac_contractor', name: 'HVAC contractor',
    aliases: ['hvac company', 'hvac service', 'heating and air conditioning', 'heating and cooling', 'air conditioning repair service'] },
  'air conditioning contractor': { enum: 'air_conditioning_contractor', name: 'Air conditioning contractor',
    aliases: ['ac repair', 'air conditioning repair service', 'air conditioning company', 'hvac contractor'] },
  'electrician': { enum: 'electrician', name: 'Electrician', aliases: ['electrical contractor', 'electrical service', 'electric company'] },
  'general contractor': { enum: 'general_contractor', name: 'General contractor',
    aliases: ['construction company', 'remodeling contractor', 'building contractor', 'home builder'] },
  'solar energy contractor': { enum: 'solar_energy_contractor', name: 'Solar energy contractor',
    aliases: ['solar panel company', 'solar installation', 'solar energy company'] },
  'painter': { enum: 'painter', name: 'Painter', aliases: ['painting contractor', 'painting company', 'painting service'] },
  'painting contractor': { enum: 'painter', name: 'Painter', aliases: ['painter', 'painting company', 'painting service'] },
  'pest control service': { enum: 'pest_control_service', name: 'Pest control service', aliases: ['pest control company', 'exterminator'] },

  // Healthcare & Wellness
  'dentist': { enum: 'dentist', name: 'Dentist', aliases: ['dental clinic', 'dental office'] },
  'cosmetic dentist': { enum: 'cosmetic_dentist', name: 'Cosmetic dentist', aliases: ['cosmetic dentistry'] },
  'medical spa': { enum: 'facial_spa', name: 'Medical spa', aliases: ['medspa', 'aesthetic clinic'] },
  'chiropractor': { enum: 'chiropractor', name: 'Chiropractor', aliases: ['chiropractic clinic'] },

  // Automotive
  'car detailing service': { enum: 'car_detailing_service', name: 'Car detailing service', aliases: ['auto detailing'] },
  'auto repair shop': { enum: 'auto_repair_shop', name: 'Auto repair shop', aliases: ['auto repair service', 'car repair shop'] },

  // Professional Services
  'lawyer': { enum: 'lawyer', name: 'Lawyer', aliases: ['law firm', 'attorney'] },
  'accountant': { enum: 'accountant', name: 'Accountant', aliases: ['accounting firm', 'cpa'] },
  'real estate agency': { enum: 'real_estate_agency', name: 'Real estate agency', aliases: ['realtor', 'real estate agent'] }
};

/**
 * Resolve a niche string to an official Google Maps category object.
 * Returns { enum: string, name: string }
 */
export function getOfficialCategory(nicheStr) {
  if (!nicheStr) return { enum: 'business', name: 'Business' };
  const clean = nicheStr.trim().toLowerCase();

  if (GOOGLE_MAPS_CATEGORIES[clean]) {
    return GOOGLE_MAPS_CATEGORIES[clean];
  }

  // Partial match fallback
  for (const [key, val] of Object.entries(GOOGLE_MAPS_CATEGORIES)) {
    if (clean.includes(key) || key.includes(clean)) {
      return val;
    }
  }

  // Dynamic fallback: build enum ID from string
  const enumId = clean.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const name = clean.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { enum: enumId, name, aliases: [] };
}
