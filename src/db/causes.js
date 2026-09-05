/**
 * Hardcoded causes list — acts as the `causes` table per spec.
 * Each cause has id, name, description, target_amount (KES)
 */
const causes = [
  {
    id: 'clean-water',
    name: 'Clean Water',
    description: 'Provide clean drinking water to rural communities in Turkana.',
    target_amount: 500000,
    emoji: '💧'
  },
  {
    id: 'school-books',
    name: 'School Books',
    description: 'Supply textbooks and stationery to primary schools in Kibera.',
    target_amount: 300000,
    emoji: '📚'
  },
  {
    id: 'health-clinic',
    name: 'Health Clinic',
    description: 'Support mobile health clinics serving remote villages.',
    target_amount: 750000,
    emoji: '🏥'
  }
];

function getCauseById(id) {
  return causes.find(c => c.id === id) || null;
}

function getCauseByIndex(index) {
  // 1-based index for USSD menu
  return causes[index - 1] || null;
}

module.exports = { causes, getCauseById, getCauseByIndex };
