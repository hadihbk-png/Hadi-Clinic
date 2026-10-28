const Stripe = require('stripe');

// Refundable consultation deposit: AED 100, in fils (the smallest unit)
const DEPOSIT_CURRENCY = 'aed';
const DEPOSIT_AMOUNT = 10000;

let stripeClient = null;

/**
 * Get the Stripe client, created on first use from STRIPE_SECRET_KEY in .env
 * @returns {Stripe} Stripe client
 */
function getStripe() {
  if (stripeClient) {
    return stripeClient;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set in .env');
  }
  // Test mode only: refuse live keys
  if (!/^(sk|rk)_test_/.test(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe test key (sk_test_...)');
  }

  stripeClient = new Stripe(secretKey);
  return stripeClient;
}

/**
 * Get the site's base URL from BASE_URL in .env, without a trailing slash
 * @returns {string} Base URL
 */
function getBaseUrl() {
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    throw new Error('BASE_URL is not set in .env');
  }
  return baseUrl.replace(/\/+$/, '');
}

class PaymentService {
  /**
   * Create a Stripe Checkout Session for the consultation deposit
   * @param {Object} booking - Saved appointment
   * @returns {Promise<Object>} Checkout Session (id and hosted url)
   */
  static async createDepositCheckoutSession(booking) {
    const baseUrl = getBaseUrl();

    return getStripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: DEPOSIT_CURRENCY,
          unit_amount: DEPOSIT_AMOUNT,
          product_data: {
            name: 'Refundable consultation deposit',
            description: `${booking.specialty} with ${booking.doctor} on ${booking.appointmentDateTime}`
          }
        }
      }],
      customer_email: booking.patientEmail,
      client_reference_id: String(booking.id),
      metadata: { appointmentId: String(booking.id) },
      success_url: `${baseUrl}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/booking`
    });
  }

  /**
   * Retrieve a Checkout Session from Stripe
   * @param {string} sessionId - Checkout Session id
   * @returns {Promise<Object>} Checkout Session
   */
  static async retrieveCheckoutSession(sessionId) {
    return getStripe().checkout.sessions.retrieve(sessionId);
  }
}

PaymentService.DEPOSIT_CURRENCY = DEPOSIT_CURRENCY;
PaymentService.DEPOSIT_AMOUNT = DEPOSIT_AMOUNT;

module.exports = PaymentService;
