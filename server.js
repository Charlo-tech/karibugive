require('dotenv').config();
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));

// Middleware
app.use(express.urlencoded({ extended: true })); // AT sends form-encoded
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Simple request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-start}ms)`);
  });
  next();
});

// Ensure DB is initialized (require triggers schema)
require('./src/db/db');

// Routes
const publicRoutes = require('./src/routes/public');
const ussdRoutes = require('./src/routes/ussd');
const paymentRoutes = require('./src/routes/payment');
const adminRoutes = require('./src/routes/admin');

app.use('/', publicRoutes);
app.use('/ussd', ussdRoutes);
app.use('/payment-callback', paymentRoutes);
app.use('/mpesa-callback', paymentRoutes); // alias for Daraja / mpesa-service callback (same handler)
app.use('/daraja-callback', paymentRoutes); // alias
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).send('Not found — <a href="/">Go home</a>');
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).send('Internal error');
});

app.listen(PORT, () => {
  console.log(`\n  Karibu Give ❤  running at http://localhost:${PORT}`);
  console.log(`  USSD callback: POST http://localhost:${PORT}/ussd`);
  console.log(`  Payment callback: POST http://localhost:${PORT}/payment-callback (also /mpesa-callback, /daraja-callback)`);
  console.log(`  M-Pesa service: ${process.env.MPESA_SERVICE_URL || 'https://mpesa-service-3s2d.onrender.com'}/stkpush`);
  console.log(`  Admin: http://localhost:${PORT}/admin  (user: ${process.env.ADMIN_USER||'admin'})`);
  console.log(`  USSD code: ${process.env.AT_USSD_CODE||'*384*1234#'}\n`);
});

module.exports = app;
