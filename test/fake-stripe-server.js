// Local stand-in for the Stripe API and Stripe-hosted Checkout, for testing
// the deposit flow without a Stripe account. Implements only what the app uses:
//   POST /v1/checkout/sessions        create a Checkout Session
//   GET  /v1/checkout/sessions/:id    retrieve a Checkout Session
//   GET  /checkout/:id                fake hosted checkout page
//   POST /checkout/:id/pay | /cancel  patient pays or cancels
const http = require('http');

function startFakeStripe(port = 12111) {
  const sessions = new Map();
  const requests = [];
  let counter = 0;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
  const stripeError = (res, status, message) => json(res, status, { error: { type: 'invalid_request_error', message } });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const parts = url.pathname.split('/').filter(Boolean);

      // --- Stripe API ---
      if (parts[0] === 'v1') {
        const auth = req.headers.authorization || '';
        if (!/^Bearer sk_test_/.test(auth)) {
          return stripeError(res, 401, 'Invalid API Key provided');
        }

        if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
          const params = Object.fromEntries(new URLSearchParams(body));
          requests.push(params);
          // Unique across restarts, like real Stripe ids
          const id = `cs_test_local_${Date.now().toString(36)}${++counter}`;
          const session = {
            id,
            object: 'checkout.session',
            mode: params.mode,
            status: 'open',
            payment_status: 'unpaid',
            currency: params['line_items[0][price_data][currency]'],
            amount_total: Number(params['line_items[0][price_data][unit_amount]']) * Number(params['line_items[0][quantity]']),
            customer_email: params.customer_email,
            client_reference_id: params.client_reference_id,
            metadata: { appointmentId: params['metadata[appointmentId]'] },
            success_url: params.success_url,
            cancel_url: params.cancel_url,
            url: `http://localhost:${port}/checkout/${id}`
          };
          sessions.set(id, session);
          return json(res, 200, session);
        }

        if (req.method === 'GET' && parts[1] === 'checkout' && parts[2] === 'sessions' && parts[3]) {
          const session = sessions.get(parts[3]);
          return session ? json(res, 200, session) : stripeError(res, 404, `No such checkout.session: '${parts[3]}'`);
        }

        return stripeError(res, 404, 'Unrecognized request URL');
      }

      // --- Fake hosted checkout page ---
      if (parts[0] === 'checkout' && parts[1]) {
        const session = sessions.get(parts[1]);
        if (!session) {
          return send(res, 404, 'Checkout session not found');
        }

        if (req.method === 'POST' && parts[2] === 'pay') {
          session.payment_status = 'paid';
          session.status = 'complete';
          return send(res, 303, '', { Location: session.success_url.replace('{CHECKOUT_SESSION_ID}', session.id) });
        }
        if (req.method === 'POST' && parts[2] === 'cancel') {
          return send(res, 303, '', { Location: session.cancel_url });
        }

        const amount = (session.amount_total / 100).toFixed(2);
        return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Fake Stripe Checkout</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:3rem auto;padding:0 16px}
.box{border:1px solid #ccc;border-radius:8px;padding:1.5rem}.warn{background:#fff3cd;padding:.5rem;border-radius:4px;font-size:.9rem}
button{padding:.7rem 1.2rem;margin-right:.5rem;font-size:1rem;cursor:pointer}</style></head><body>
<div class="box"><p class="warn">LOCAL TEST CHECKOUT - not real Stripe, no money moves.</p>
<h2>Pay ${session.currency.toUpperCase()} ${amount}</h2><p>Refundable consultation deposit<br>${session.customer_email}</p>
<form method="post" action="/checkout/${session.id}/pay" style="display:inline"><button>Pay</button></form>
<form method="post" action="/checkout/${session.id}/cancel" style="display:inline"><button>Cancel</button></form>
</div></body></html>`, { 'Content-Type': 'text/html' });
      }

      send(res, 404, 'Not found');
    });
  });

  return new Promise(resolve => {
    server.listen(port, () => resolve({ server, sessions, requests, port }));
  });
}

module.exports = { startFakeStripe };

if (require.main === module) {
  const port = Number(process.env.FAKE_STRIPE_PORT) || 12111;
  startFakeStripe(port).then(() => console.log(`Fake Stripe running at http://localhost:${port}`));
}
