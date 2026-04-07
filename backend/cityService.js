import zipcodes from 'zipcodes';

// =========================
// GET ALL ZIPCODES FROM LOCATION
// =========================
// If location is a state e.g., "TX" -> return all TX zips
// If location is a city/state e.g., "Houston, TX" -> return Houston zips
// Fallback -> return the raw location string
export async function getSubLocations(locationName) {
  let zips = [];

  try {
    // Check if it looks like City, State (e.g. "Houston, TX" or "San Francisco, CA")
    if (locationName.includes(",")) {
      const [city, state] = locationName.split(",").map(s => s.trim());
      if (state && state.length === 2) {
        const found = zipcodes.lookupByName(city, state);
        if (found && found.length > 0) {
          zips = found.map(z => z.zip);
        }
      }
    } 
    // Check if it's just a state (e.g., "TX" or "CA")
    else if (locationName.trim().length === 2) {
      const state = locationName.trim().toUpperCase();
      const stZips = zipcodes.lookupByState(state);
      if (stZips && stZips.length > 0) {
        zips = stZips;
      }
    }

    // Removing duplicates if any
    zips = [...new Set(zips)];

    if (zips.length > 0) {
      console.log(`🌍 Expanded ${locationName} to ${zips.length} ZIP codes.`);
      return zips;
    }
    
    console.log(`⚠️ Could not map "${locationName}" to ZIPs. Falling back to single query.`);
    return [locationName];

  } catch (err) {
    console.log("❌ Location mapping error:", err.message);
    return [locationName];
  }
}