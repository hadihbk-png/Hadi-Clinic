// Load settings and secrets (Stripe, SMTP, reception login, AI key) from .env
try {
  process.loadEnvFile();
} catch (error) {
  console.warn(`.env not loaded (${error.message}) - Stripe deposits will not work until it is set up`);
}

const express = require('express');
const path = require('path');
const bookingRoutes = require('./routes/booking');
const receptionRoutes = require('./routes/reception');
const chatRoutes = require('./routes/chat');
const authRoutes = require('./routes/auth');
const AppointmentService = require('./services/appointmentService');
const UserService = require('./services/userService');
const { requireRole } = require('./services/auth');
const https = require('https');

// Initialize database (tables are created/upgraded in the background)
const db = require('./data/db');

// Then create/update the reception staff account from .env
const startup = db.ready.then(() => UserService.seedReceptionUser());
startup.catch(error => console.error('Startup failed:', error.message));

const app = express();
const PORT = process.env.PORT || 3005;

// On Vercel, requests arrive through Vercel's HTTPS proxy: trust its
// X-Forwarded-* headers so req.protocol is "https" (same-site checks and
// Secure login cookies depend on it)
if (process.env.VERCEL) {
  app.set('trust proxy', true);
}

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Name shown in the "built by" sign-offs (footer and emails)
app.locals.builtBy = process.env.BUILT_BY || 'Developer';

// Serve static files (on Vercel, public/ is served by the CDN instead)
app.use(express.static(path.join(__dirname, 'public')));

// Wait for the database to be ready before handling any page
// (on Vercel a request can arrive while a new instance is still starting)
app.use(async (req, res, next) => {
  try {
    await startup;
    next();
  } catch (error) {
    res.status(503).send('The clinic website is temporarily unavailable. Please call +971 4 123 4567.');
  }
});

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

// Staff login and logout
app.use('/', authRoutes);

// Admin bookings view (simple admin panel, reception staff only)
app.get('/admin/bookings', requireRole('reception'), async (req, res) => {
  const allBookings = await AppointmentService.getAllBookings();
  res.render('admin-bookings', {
    bookings: allBookings
  });
});

// Booking routes
app.use('/booking', bookingRoutes);

// Chat assistant API (calls the AI provider server-side)
app.use('/api', chatRoutes);

// Reception dashboard (reception role only)
app.use('/reception', requireRole('reception'), receptionRoutes);

// Stripe Checkout returns here after the deposit payment
app.get('/booking-success', bookingRoutes.bookingSuccess);

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT} (database: ${db.storage})`);
});
