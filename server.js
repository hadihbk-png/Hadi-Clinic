// Load settings and secrets (Stripe, SMTP, staff password) from .env
try {
  process.loadEnvFile();
} catch (error) {
  console.warn(`.env not loaded (${error.message}) - Stripe deposits will not work until it is set up`);
}

const express = require('express');
const path = require('path');
const bookingRoutes = require('./routes/booking');
const receptionRoutes = require('./routes/reception');
const AppointmentService = require('./services/appointmentService');
const { requireStaff } = require('./services/staffAuth');
const https = require('https');

// Initialize database
require('./data/db');

const app = express();
const PORT = process.env.PORT || 3005;

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Name shown in the "built by" sign-offs (footer and emails)
app.locals.builtBy = process.env.BUILT_BY || 'Developer';

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Image proxy route - proxy external images to avoid ORB issues
app.get('/proxy-image', (req, res) => {
  const imageUrl = req.query.url;
  
  if (!imageUrl) {
    return res.status(400).send('Image URL required');
  }

  // Only allow Unsplash URLs for security
  if (!imageUrl.startsWith('https://images.unsplash.com')) {
    return res.status(403).send('Only Unsplash images allowed');
  }

  https.get(imageUrl, (proxyRes) => {
    // Set proper CORS and cache headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('Content-Type', proxyRes.headers['content-type']);
    
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.error('Proxy error:', err);
    res.status(500).send('Error loading image');
  });
});

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

// Admin bookings view (simple admin panel, staff only)
app.get('/admin/bookings', requireStaff, (req, res) => {
  const allBookings = AppointmentService.getAllBookings();
  res.render('admin-bookings', {
    bookings: allBookings
  });
});

// Booking routes
app.use('/booking', bookingRoutes);

// Reception staff page (staff only)
app.use('/reception', requireStaff, receptionRoutes);

// Stripe Checkout returns here after the deposit payment
app.get('/booking-success', bookingRoutes.bookingSuccess);

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
