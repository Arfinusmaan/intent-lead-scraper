export function scoreLead(lead) {
  let score = 0;

  if (lead.website && lead.website.trim()) {
    score += 2;
  }

  if (lead.email && lead.email.trim()) {
    score += 2;
  }

  const reviews = parseInt(lead.reviews, 10) || 0;
  const rating = parseFloat(lead.rating) || 0;

  if (reviews > 20) {
    score += 1;
  }

  if (rating > 0 && rating < 4.5) {
    score += 2;
  }

  if (reviews > 0 && reviews < 10) {
    score += 2;
  }

  let intent_tag;
  if (score >= 6) {
    intent_tag = 'HIGH_INTENT';
  } else if (score >= 3) {
    intent_tag = 'MEDIUM';
  } else {
    intent_tag = 'LOW';
  }

  return { score, intent_tag };
}
