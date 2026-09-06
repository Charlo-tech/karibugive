const express = require('express');
const router = express.Router();
const { getStats, getRaisedByCause } = require('../services/donations');

router.get('/', (req, res) => {
  const stats = getStats();
  const causes = getRaisedByCause({ activeOnly: true });
  res.render('index', {
    stats,
    causes,
    ussdCode: process.env.AT_USSD_CODE || '*384*1234#'
  });
});

router.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

module.exports = router;
