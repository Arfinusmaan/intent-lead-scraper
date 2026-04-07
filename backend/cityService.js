import zipcodes from 'zipcodes';
import { State, City } from 'country-state-city';

// =========================
// GEOGRAPHIC EXPANSION
// =========================
export async function getSubLocations(locationName) {
  let subLocations = [];

  try {
    const query = locationName.trim();
    const queryLower = query.toLowerCase();

    // 1. Detect if input is a State/Province
    const usStates = State.getStatesOfCountry('US');
    const caStates = State.getStatesOfCountry('CA');
    const allStates = [...usStates, ...caStates];

    const matchedState = allStates.find(s => 
      s.name.toLowerCase() === queryLower || 
      s.isoCode.toLowerCase() === queryLower
    );

    if (matchedState) {
      const cities = City.getCitiesOfState(matchedState.countryCode, matchedState.isoCode);
      subLocations = cities.map(c => `${c.name}, ${matchedState.isoCode}`);
      
      // Deduplicate (some states list same city name multiple times for counties)
      subLocations = [...new Set(subLocations)];
      
      console.log(`🌍 Expanded State "${matchedState.name}" into ${subLocations.length} Cities.`);
      return subLocations;
    }

    // 2. Detect City -> Zipcodes (US Only)
    // Format must be "City, State" like "Houston, TX"
    if (query.includes(",")) {
      const parts = query.split(",");
      const city = parts[0].trim();
      const state = parts[1].trim();

      if (state.length === 2 || state.length === 3) {
        const found = zipcodes.lookupByName(city, state);
        if (found && found.length > 0) {
          subLocations = found.map(z => z.zip).filter(Boolean);
          subLocations = [...new Set(subLocations)];
          
          if (subLocations.length > 0) {
            console.log(`🌍 Expanded "${query}" into ${subLocations.length} ZIP codes.`);
            return subLocations;
          }
        }
      }
    }

    // 3. Fallback (Single Query string like "Toronto" or unsupported formatting)
    console.log(`⚠️ Searching location exactly as provided: "${locationName}"`);
    return [locationName];

  } catch (err) {
    console.log("❌ Location mapping error:", err.message);
    return [locationName];
  }
}