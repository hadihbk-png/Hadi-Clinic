// Preload (node --require) that points the stripe package at the local fake
// Stripe server instead of api.stripe.com. Only used for local testing.
const path = require('path');

const port = Number(process.env.FAKE_STRIPE_PORT) || 12111;
const stripePath = require.resolve('stripe', { paths: [path.join(__dirname, '..')] });
const Stripe = require(stripePath);

class LocalStripe extends Stripe {
  constructor(key, config = {}) {
    super(key, { ...config, host: 'localhost', port, protocol: 'http' });
  }
}

require.cache[stripePath].exports = LocalStripe;
console.log(`[test] Stripe API calls go to fake Stripe at http://localhost:${port}`);
