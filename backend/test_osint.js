import { extractMedicalDecisionMaker } from './decisionMaker.js';

(async () => {
   const res = await extractMedicalDecisionMaker("Ideal Dental", "idealdental.com");
   console.log("Extraction Result:", res);
})();
