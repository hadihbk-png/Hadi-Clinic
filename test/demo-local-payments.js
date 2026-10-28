// Click through the deposit flow in a browser without a Stripe account or
// mail server: starts the fake Stripe, a fake SMTP server that prints each
// email here, and the app (port 3006, separate demo database).
// Run: npm run demo:payments
const { spawn } = require('child_process');
const path = require('path');
const { startFakeStripe } = require('./fake-stripe-server');
const { startFakeSmtp } = require('./fake-smtp-server');

const APP_PORT = 3006;
const STRIPE_PORT = 12111;
const SMTP_PORT = 2525;

Promise.all([startFakeStripe(STRIPE_PORT), startFakeSmtp(SMTP_PORT)]).then(([, smtp]) => {
  // Print every email the app sends
  const push = smtp.state.messages.push.bind(smtp.state.messages);
  smtp.state.messages.push = mail => {
    const decoded = Buffer.from(
      mail.raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      'latin1'
    ).toString('utf8');
    const text = decoded.split(/Content-Type: text\/plain[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/)[1]?.split(/\r\n-+_NmP/)[0];
    console.log(`\n===== EMAIL to ${mail.to.join(', ')} =====\n${decoded.match(/^Subject: .*$/m)?.[0]}\n\n${text}\n=====\n`);
    return push(mail);
  };

  const app = spawn(process.execPath, ['--require', path.join(__dirname, 'use-fake-stripe.js'), 'server.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      BASE_URL: `http://localhost:${APP_PORT}`,
      DB_PATH: path.join(__dirname, '..', 'data', 'demo.db'),
      STRIPE_SECRET_KEY: 'sk_test_local_demo',
      FAKE_STRIPE_PORT: String(STRIPE_PORT),
      SMTP_HOST: 'localhost',
      SMTP_PORT: String(SMTP_PORT),
      SMTP_USER: 'demo',
      SMTP_PASS: 'demo',
      SMTP_FROM: 'bookings@hadiclinic.test'
    }
  });
  app.on('exit', code => process.exit(code ?? 0));
  console.log(`Demo with fake Stripe: http://localhost:${APP_PORT}/booking`);
  console.log(`Admin view:            http://localhost:${APP_PORT}/admin/bookings`);
});
