import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { State, City } from 'country-state-city';

const US_ZIPS_FILE = path.join(process.cwd(), '..', 'uszips.csv');
const CA_ZIPS_FILE = path.join(process.cwd(), '..', 'zipcodes.ca.csv');

// In-memory indexing
const usZipsByState = new Map();
const usZipsByCityState = new Map();

const caFsaByProvince = new Map();
const caFsaByCityProvince = new Map();

let dbsLoaded = false;
let loadPromise = null;

function loadDatabases() {
  if (dbsLoaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    let pending = 0;

    const checkDone = () => {
      pending--;
      if (pending === 0) {
        dbsLoaded = true;
        resolve();
      }
    };

    if (fs.existsSync(US_ZIPS_FILE)) {
      pending++;
      fs.createReadStream(US_ZIPS_FILE)
        .pipe(csv())
        .on('data', (row) => {
          if (!row.zip || !row.state_id) return;
          const stateId = row.state_id.toLowerCase();
          const zip = `${row.zip}, ${row.state_id}, USA`;
          
          if (!usZipsByState.has(stateId)) usZipsByState.set(stateId, new Set());
          usZipsByState.get(stateId).add(zip);

          if (row.city) {
            const cityKey = `${row.city.toLowerCase().trim()},${stateId}`;
            if (!usZipsByCityState.has(cityKey)) usZipsByCityState.set(cityKey, new Set());
            usZipsByCityState.get(cityKey).add(zip);
          }
        })
        .on('end', () => {
          console.log(`🇺🇸 US ZIPs DB Loaded in memory`);
          checkDone();
        });
    }

    if (fs.existsSync(CA_ZIPS_FILE)) {
      pending++;
      fs.createReadStream(CA_ZIPS_FILE)
        .pipe(csv())
        .on('data', (row) => {
          if (!row.zipcode || !row.state_code) return;
          const provCode = row.state_code.toLowerCase();
          const fsa = `${row.zipcode}, ${row.state_code}, Canada`;

          if (!caFsaByProvince.has(provCode)) caFsaByProvince.set(provCode, new Set());
          caFsaByProvince.get(provCode).add(fsa);

          if (row.place) {
            // place might be "Eastern Alberta (St. Paul)"
            let cityFull = row.place.toLowerCase().trim();
            const cityKey = `${cityFull},${provCode}`;
            if (!caFsaByCityProvince.has(cityKey)) caFsaByCityProvince.set(cityKey, new Set());
            caFsaByCityProvince.get(cityKey).add(fsa);

            // Extract "St. Paul" if there are parens
            const match = cityFull.match(/\(([^)]+)\)/);
            if (match) {
                const subCity = match[1].trim();
                const subCityKey = `${subCity},${provCode}`;
                if (!caFsaByCityProvince.has(subCityKey)) caFsaByCityProvince.set(subCityKey, new Set());
                caFsaByCityProvince.get(subCityKey).add(fsa);
            }
          }
        })
        .on('end', () => {
          console.log(`🍁 CA FSAs DB Loaded in memory`);
          checkDone();
        });
    }

    if (pending === 0) resolve();
  });

  return loadPromise;
}

export async function getSubLocations(locationName) {
  let subLocations = [];

  try {
    await loadDatabases();

    const query = locationName.trim();
    const queryLower = query.toLowerCase();

    // 1. Universal State/Province Expansion
    const allStates = State.getAllStates();
    const matchedState = allStates.find(s => 
      s.name.toLowerCase() === queryLower || 
      s.isoCode.toLowerCase() === queryLower ||
      (s.countryCode + "-" + s.isoCode).toLowerCase() === queryLower
    );

    if (matchedState) {
      if (matchedState.countryCode === 'US' && usZipsByState.has(matchedState.isoCode.toLowerCase())) {
         const zips = Array.from(usZipsByState.get(matchedState.isoCode.toLowerCase()));
         console.log(`🇺🇸 Expanded US state "${matchedState.name}" → ${zips.length} ZIP codes (from custom DB).`);
         return zips;
      }
      if (matchedState.countryCode === 'CA' && caFsaByProvince.has(matchedState.isoCode.toLowerCase())) {
         const fsas = Array.from(caFsaByProvince.get(matchedState.isoCode.toLowerCase()));
         console.log(`🍁 Expanded CA province "${matchedState.name}" → ${fsas.length} FSA codes (from custom DB).`);
         return fsas;
      }

      // Fallback for non-US/CA states
      const cities = City.getCitiesOfState(matchedState.countryCode, matchedState.isoCode);
      subLocations = cities.map(c => `${c.name}, ${matchedState.isoCode}, ${matchedState.countryCode}`);
      subLocations = [...new Set(subLocations)];
      console.log(`🌍 Expanded "${matchedState.name}" (${matchedState.countryCode}) → ${subLocations.length} cities.`);
      return subLocations.length > 0 ? subLocations : [locationName];
    }

    // 2. City → ZIP/FSA Expansion
    if (query.includes(",")) {
      const parts = query.split(",").map(p => p.trim());
      const city = parts[0];
      const prov = parts[1].toLowerCase();

      // Check US
      const usKey = `${city.toLowerCase()},${prov}`;
      if (usZipsByCityState.has(usKey)) {
         const zips = Array.from(usZipsByCityState.get(usKey));
         console.log(`🇺🇸 Expanded US city "${query}" → ${zips.length} ZIP codes.`);
         return zips;
      }

      // Check CA
      const caKey = `${city.toLowerCase()},${prov}`;
      if (caFsaByCityProvince.has(caKey)) {
         const fsas = Array.from(caFsaByCityProvince.get(caKey));
         console.log(`🍁 Expanded CA city "${query}" → ${fsas.length} FSA codes.`);
         return fsas;
      }
    }

    // 3. Try plain city name against DB (e.g., "Toronto" or "Houston")
    if (!query.includes(",")) {
        let matchingFsas = new Set();
        for (const [key, fsas] of caFsaByCityProvince.entries()) {
            if (key.startsWith(queryLower + ",")) {
                for(let fsa of fsas) matchingFsas.add(fsa);
            }
        }
        if (matchingFsas.size > 0) {
            const arr = Array.from(matchingFsas);
            console.log(`🍁 Expanded CA city "${query}" → ${arr.length} FSA codes.`);
            return arr;
        }

        let matchingUsZips = new Set();
        for (const [key, zips] of usZipsByCityState.entries()) {
            if (key.startsWith(queryLower + ",")) {
                for(let zip of zips) matchingUsZips.add(zip);
            }
        }
        if (matchingUsZips.size > 0) {
            const arr = Array.from(matchingUsZips);
            console.log(`🇺🇸 Expanded US city "${query}" → ${arr.length} ZIP codes.`);
            return arr;
        }
    }

    console.log(`⚠️ No custom DB expansion found for "${locationName}", searching as-is.`);
    return [locationName];

  } catch (err) {
    console.log("❌ Location mapping error:", err.message);
    return [locationName];
  }
}