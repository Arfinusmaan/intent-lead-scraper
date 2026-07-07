import { isNicheAligned } from '../backend/scraper.js';

function runTests() {
  console.log("--- RESTORATION PIPELINE TEST ---");

  const tests = [
    // GOOD LEADS
    { name: "SERVPRO of Washington County", category: "Water damage restoration service", text: "", expected: true },
    { name: "John's Water Damage & Restoration", category: "General contractor", text: "", expected: true },
    { name: "First Atlantic Restoration", category: "Fire damage restoration service", text: "", expected: true },
    { name: "Local Mold Remediation", category: "Mold remediation", text: "", expected: true },
    { name: "Elite Disaster Recovery", category: "Disaster restoration", text: "", expected: true },
    
    // BAD LEADS (JUNK TO BLOCK)
    { name: "Bob's Auto Restoration", category: "Auto body shop", text: "We restore classic cars.", expected: false },
    { name: "Sunshine Dental Spa", category: "Dental clinic", text: "Teeth restoration services.", expected: false },
    { name: "Rhode Island Harvesting Company", category: "Tractor dealer", text: "", expected: false },
    { name: "Clean Cut Painting Services", category: "Painter", text: "We restore old paint.", expected: false },
    { name: "Stonington Power Equipment", category: "Lawn mower store", text: "", expected: false },
    { name: "Arch Masonry Restoration", category: "Masonry contractor", text: "Brick pointing and chimney repair", expected: false },
    { name: "Antique Furniture Restoration", category: "Furniture repair shop", text: "", expected: false },
    { name: "City Pizza", category: "Restaurant", text: "Best pizza in town", expected: false },
    
    // EDGE CASES
    { name: "Emergency Biohazard Cleanup", category: "Cleaning service", text: "Crime scene cleanup.", expected: false },
    { name: "General Contractor", category: "Construction", text: "We do building restoration.", expected: false },
    { name: "Speedy Plumbers", category: "Plumber", text: "We fix leaks.", expected: false }
  ];

  let passed = 0;
  for (const t of tests) {
    const result = isNicheAligned("Restoration", t.name, t.category, t.text);
    const pass = result === t.expected;
    if (pass) {
      passed++;
      console.log(`✅ PASS: ${t.name} (Result: ${result ? 'KEPT' : 'BLOCKED'})`);
    } else {
      console.log(`❌ FAIL: ${t.name} (Expected: ${t.expected}, Got: ${result})`);
    }
  }

  console.log(`\nScore: ${passed} / ${tests.length} passed.`);
}

runTests();
