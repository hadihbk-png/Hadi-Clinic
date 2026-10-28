// End-to-end test of the Stripe deposit flow against the local fake Stripe.
// Runs the real server.js on a throwaway database. Run: npm run test:deposit
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startFakeStripe } = require('./fake-stripe-server');
const { startFakeSmtp } = require('./fake-smtp-server');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 3105;
const STRIPE_PORT = 12111;
const BASE_URL = `http://localhost:${APP_PORT}`;
const TEST_KEY = 'sk_test_local_fake_key_123';
const SMTP_PORT = 2525;
const SMTP_ENV = {
  SMTP_HOST: 'localhost',
  SMTP_PORT: String(SMTP_PORT),
  SMTP_USER: 'clinic-user',
  SMTP_PASS: 'clinic-pass',
  SMTP_FROM: 'bookings@hadiclinic.test'
};
const STAFF_ENV = { STAFF_USER: 'staff', STAFF_PASSWORD: 'test-staff-pass', BUILT_BY: 'Developer' };
const staffAuth = (user = 'staff', password = 'test-staff-pass') =>
  ({ Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hadi-clinic-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let fakeStripe;
let fakeSmtp;
let app;

function startApp(env, port = APP_PORT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'use-fake-stripe.js'), 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, FAKE_STRIPE_PORT: String(STRIPE_PORT), ...SMTP_ENV, ...STAFF_ENV, ...env }
    });
    let output = '';
    child.getOutput = () => output;
    child.stdout.on('data', d => {
      output += d;
      if (output.includes('Server running')) resolve(child);
    });
    child.stderr.on('data', d => { output += d; });
    child.on('exit', code => reject(new Error(`server exited (${code}): ${output}`)));
  });
}

function stopApp(child) {
  return new Promise(resolve => {
    child.removeAllListeners('exit');
    child.on('exit', resolve);
    child.kill();
  });
}

function query(sql, ...params) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const bookingForm = (overrides = {}) => new URLSearchParams({
  specialty: 'dentist',
  date: '2030-01-08',
  time: '10:00',
  patientName: 'Test Patient',
  patientEmail: 'patient@example.com',
  patientPhone: '0501234567',
  ...overrides
}).toString();

const confirmBooking = (base = BASE_URL, overrides) => fetch(`${base}/booking/confirm`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: bookingForm(overrides)
});

before(async () => {
  // Database with the old schema (no stripeSessionId) and an existing booking
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, specialty TEXT NOT NULL, doctor TEXT NOT NULL,
    appointmentDateTime DATETIME NOT NULL, patientName TEXT NOT NULL, patientPhone TEXT NOT NULL,
    patientEmail TEXT NOT NULL, status TEXT DEFAULT 'Booked', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(`INSERT INTO appointments (specialty, doctor, appointmentDateTime, patientName, patientPhone, patientEmail, status)
    VALUES ('ENT', 'Dr. Omar Khan', '2029-05-01 09:00', 'Existing Patient', '0500000000', 'old@example.com', 'Booked')`).run();
  db.close();

  fakeStripe = await startFakeStripe(STRIPE_PORT);
  fakeSmtp = await startFakeSmtp(SMTP_PORT);
  app = await startApp({ STRIPE_SECRET_KEY: TEST_KEY, BASE_URL });
});

after(async () => {
  if (app) await stopApp(app);
  if (fakeStripe) fakeStripe.server.close();
  if (fakeSmtp) fakeSmtp.server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Email is sent in the background, so poll for it
async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return check();
}
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

// Decode quoted-printable so the body can be checked as plain text
const decodeMail = raw => Buffer.from(
  raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
  'latin1'
).toString('utf8');

test('migration adds stripeSessionId and keeps existing bookings', () => {
  const columns = query('PRAGMA table_info(appointments)').map(c => c.name);
  assert.ok(columns.includes('stripeSessionId'));
  assert.ok(columns.includes('confirmationEmailSentAt'));
  const rows = query('SELECT * FROM appointments');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].patientName, 'Existing Patient');
  assert.strictEqual(rows[0].status, 'Booked');
});

let session;

test('confirm saves a Pending booking and redirects to Checkout', async () => {
  const res = await confirmBooking();
  assert.strictEqual(res.status, 303);
  const location = res.headers.get('location');
  assert.match(location, /^http:\/\/localhost:12111\/checkout\/cs_test_local_\w+$/);

  const [booking] = query('SELECT * FROM appointments ORDER BY id DESC LIMIT 1');
  assert.strictEqual(booking.status, 'Pending');
  assert.strictEqual(booking.patientEmail, 'patient@example.com');
  assert.strictEqual(location, `http://localhost:12111/checkout/${booking.stripeSessionId}`);
  session = { id: booking.stripeSessionId, bookingId: booking.id, url: location };
});

test('Checkout Session is created server-side with the right deposit and URLs', () => {
  const params = fakeStripe.requests.at(-1);
  assert.strictEqual(params.mode, 'payment');
  assert.strictEqual(params['line_items[0][price_data][currency]'], 'aed');
  assert.strictEqual(params['line_items[0][price_data][unit_amount]'], '10000');
  assert.strictEqual(params['line_items[0][quantity]'], '1');
  assert.strictEqual(params['line_items[0][price_data][product_data][name]'], 'Refundable consultation deposit');
  assert.strictEqual(params.success_url, `${BASE_URL}/booking-success?session_id={CHECKOUT_SESSION_ID}`);
  assert.strictEqual(params.cancel_url, `${BASE_URL}/booking`);
  assert.strictEqual(params.customer_email, 'patient@example.com');
  assert.strictEqual(params.client_reference_id, String(session.bookingId));
});

test('the secret key never reaches the browser', async () => {
  const pages = [`${BASE_URL}/`, `${BASE_URL}/booking`, `${BASE_URL}/booking-success?session_id=${session.id}`];
  for (const page of pages) {
    const html = await (await fetch(page)).text();
    assert.ok(!html.includes(TEST_KEY), `key leaked on ${page}`);
    assert.ok(!html.includes('sk_test_'), `secret key prefix on ${page}`);
  }
});

test('success URL before paying: not trusted, booking stays Pending', async () => {
  const res = await fetch(`${BASE_URL}/booking-success?session_id=${session.id}`);
  const html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(html.includes('Payment Not Completed'));
  assert.ok(!html.includes('Booking Confirmed!'));
  assert.strictEqual(query('SELECT status FROM appointments WHERE id = ?', session.bookingId)[0].status, 'Pending');
  await settle();
  assert.strictEqual(fakeSmtp.state.messages.length, 0, 'no email for an unpaid booking');
});

test('cancel on Checkout returns to /booking and booking stays Pending', async () => {
  const res = await fetch(`${session.url}/cancel`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), `${BASE_URL}/booking`);
  assert.strictEqual((await fetch(res.headers.get('location'))).status, 200);
  assert.strictEqual(query('SELECT status FROM appointments WHERE id = ?', session.bookingId)[0].status, 'Pending');
});

test('paying on Checkout then returning marks the booking Booked', async () => {
  const pay = await fetch(`${session.url}/pay`, { method: 'POST', redirect: 'manual' });
  assert.strictEqual(pay.status, 303);
  const successUrl = pay.headers.get('location');
  assert.strictEqual(successUrl, `${BASE_URL}/booking-success?session_id=${session.id}`);

  const res = await fetch(successUrl);
  const html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(html.includes('Booking Confirmed!'));
  assert.ok(html.includes('AED 100.00'));
  assert.ok(html.includes(`Booking ID: ${session.bookingId}`));
  assert.strictEqual(query('SELECT status FROM appointments WHERE id = ?', session.bookingId)[0].status, 'Booked');
});

test('revisiting the success page keeps it Booked', async () => {
  const html = await (await fetch(`${BASE_URL}/booking-success?session_id=${session.id}`)).text();
  assert.ok(html.includes('Booking Confirmed!'));
  assert.strictEqual(query('SELECT status FROM appointments WHERE id = ?', session.bookingId)[0].status, 'Booked');
});

test('a confirmation email is sent to the patient with the booking details', async () => {
  assert.ok(await waitFor(() => fakeSmtp.state.messages.length >= 1), 'email was sent');
  const mail = fakeSmtp.state.messages[0];
  const body = decodeMail(mail.raw);

  assert.strictEqual(mail.from, 'bookings@hadiclinic.test');
  assert.deepStrictEqual(mail.to, ['patient@example.com']);
  assert.match(body, /^From: Hadi Medical Clinic <bookings@hadiclinic\.test>/m);
  assert.match(body, /^Subject: Your appointment is confirmed/m);
  for (const expected of [
    'Specialty: Dentist',
    'Doctor: Dr. Lina Haddad',
    'Date: Tuesday, 8 January 2030',
    'Time: 10:00',
    'Address: Cluster X, JLT, Dubai, UAE',
    'Hadi Medical Clinic · built at London International · lisrc.ae · by Developer'
  ]) {
    assert.ok(body.includes(expected), `email contains "${expected}"`);
  }
  assert.ok(query('SELECT confirmationEmailSentAt FROM appointments WHERE id = ?', session.bookingId)[0].confirmationEmailSentAt);
});

test('refreshing the success page, even all at once, does not send it again', async () => {
  const url = `${BASE_URL}/booking-success?session_id=${session.id}`;
  await Promise.all(Array.from({ length: 5 }, () => fetch(url).then(r => r.text())));
  await fetch(url).then(r => r.text());
  await settle();
  assert.strictEqual(fakeSmtp.state.messages.length, 1);
});

test('if sending fails: error logged, booking still confirmed, retried on next visit', async () => {
  const res = await confirmBooking(BASE_URL, { patientEmail: 'mailfail@example.com' });
  const checkoutUrl = res.headers.get('location');
  const [booking] = query("SELECT * FROM appointments WHERE patientEmail = 'mailfail@example.com'");
  const pay = await fetch(`${checkoutUrl}/pay`, { method: 'POST', redirect: 'manual' });

  const sentBefore = fakeSmtp.state.messages.length;
  fakeSmtp.state.failNext = true;
  const page = await fetch(pay.headers.get('location'));
  const html = await page.text();
  assert.strictEqual(page.status, 200);
  assert.ok(html.includes('Booking Confirmed!'));
  assert.strictEqual(query('SELECT status FROM appointments WHERE id = ?', booking.id)[0].status, 'Booked');

  assert.ok(await waitFor(() => app.getOutput().includes(`Error sending confirmation email for booking ${booking.id}`)), 'error logged');
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore);
  assert.strictEqual(query('SELECT confirmationEmailSentAt FROM appointments WHERE id = ?', booking.id)[0].confirmationEmailSentAt, null);

  // Mail server is back: the next visit sends it, exactly once
  await fetch(pay.headers.get('location')).then(r => r.text());
  assert.ok(await waitFor(() => fakeSmtp.state.messages.length === sentBefore + 1));
  await fetch(pay.headers.get('location')).then(r => r.text());
  await settle();
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore + 1);
  assert.deepStrictEqual(fakeSmtp.state.messages.at(-1).to, ['mailfail@example.com']);
});

test('missing SMTP settings: error logged, booking still confirmed', async () => {
  const port = APP_PORT + 3;
  const noSmtpApp = await startApp({ STRIPE_SECRET_KEY: TEST_KEY, BASE_URL: `http://localhost:${port}`, SMTP_HOST: '' }, port);
  try {
    const res = await confirmBooking(`http://localhost:${port}`, { patientEmail: 'nosmtp@example.com' });
    const pay = await fetch(`${res.headers.get('location')}/pay`, { method: 'POST', redirect: 'manual' });
    const html = await (await fetch(pay.headers.get('location'))).text();
    assert.ok(html.includes('Booking Confirmed!'));
    assert.ok(await waitFor(() => noSmtpApp.getOutput().includes('SMTP_HOST, SMTP_PORT and SMTP_FROM must be set')));
  } finally {
    await stopApp(noSmtpApp);
  }
});

test('another unpaid booking cannot be confirmed by visiting the success URL', async () => {
  const res = await confirmBooking(BASE_URL, { patientEmail: 'second@example.com' });
  assert.strictEqual(res.status, 303);
  const [second] = query("SELECT * FROM appointments WHERE patientEmail = 'second@example.com'");

  const html = await (await fetch(`${BASE_URL}/booking-success?session_id=${second.stripeSessionId}`)).text();
  assert.ok(html.includes('Payment Not Completed'));
  assert.strictEqual(query('SELECT status FROM appointments WHERE id = ?', second.id)[0].status, 'Pending');
});

test('unknown or missing session id is rejected', async () => {
  const before = query('SELECT id, status FROM appointments');

  const unknown = await fetch(`${BASE_URL}/booking-success?session_id=cs_test_forged`);
  assert.strictEqual(unknown.status, 404);
  assert.ok((await unknown.text()).includes('could not find a booking'));

  const missing = await fetch(`${BASE_URL}/booking-success`);
  assert.strictEqual(missing.status, 404);

  assert.deepStrictEqual(query('SELECT id, status FROM appointments'), before);
});

test('a live key is refused and the patient sees an error', async () => {
  const port = APP_PORT + 1;
  const liveApp = await startApp({ STRIPE_SECRET_KEY: 'sk_live_not_allowed', BASE_URL: `http://localhost:${port}` }, port);
  try {
    const requestsBefore = fakeStripe.requests.length;
    const res = await confirmBooking(`http://localhost:${port}`, { patientEmail: 'live@example.com' });
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes('We could not start the deposit payment'));
    assert.strictEqual(fakeStripe.requests.length, requestsBefore, 'no call reached Stripe');
  } finally {
    await stopApp(liveApp);
  }
});

test('a missing key is refused and the patient sees an error', async () => {
  const port = APP_PORT + 2;
  const noKeyApp = await startApp({ STRIPE_SECRET_KEY: '', BASE_URL: `http://localhost:${port}` }, port);
  try {
    const res = await confirmBooking(`http://localhost:${port}`, { patientEmail: 'nokey@example.com' });
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes('We could not start the deposit payment'));
  } finally {
    await stopApp(noKeyApp);
  }
});

// --- Reception page ---

const remind = (id, headers = staffAuth()) =>
  fetch(`${BASE_URL}/reception/${id}/remind`, { method: 'POST', redirect: 'manual', headers });
const staffGet = path => fetch(`${BASE_URL}${path}`, { headers: staffAuth() });

test('staff pages require the staff login', async () => {
  for (const path of ['/reception', '/admin/bookings']) {
    const none = await fetch(`${BASE_URL}${path}`);
    assert.strictEqual(none.status, 401, `${path} without login`);
    assert.match(none.headers.get('www-authenticate'), /^Basic /);
    assert.strictEqual((await fetch(`${BASE_URL}${path}`, { headers: staffAuth('staff', 'wrong') })).status, 401);
    assert.strictEqual((await fetch(`${BASE_URL}${path}`, { headers: staffAuth('other', 'test-staff-pass') })).status, 401);
    assert.strictEqual((await staffGet(path)).status, 200, `${path} with login`);
  }

  const sentBefore = fakeSmtp.state.messages.length;
  assert.strictEqual((await remind(session.bookingId, {})).status, 401);
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore, 'no reminder without login');

  // Patient pages stay public
  assert.strictEqual((await fetch(`${BASE_URL}/booking`)).status, 200);
});

test('a reminder posted from another site is blocked', async () => {
  const sentBefore = fakeSmtp.state.messages.length;
  const res = await remind(session.bookingId, { ...staffAuth(), Origin: 'https://evil.example' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore);
});

test('reception lists only upcoming Booked appointments with their details', async () => {
  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO appointments (specialty, doctor, appointmentDateTime, patientName, patientPhone, patientEmail, status)
    VALUES ('ENT', 'Dr. Omar Khan', '2020-01-01 09:00', 'Past Patient', '0500000001', 'past@example.com', 'Booked')`).run();
  db.close();

  const res = await staffGet('/reception');
  const html = await res.text();
  assert.strictEqual(res.status, 200);

  const today = new Date().toLocaleDateString('en-CA');
  const upcoming = query("SELECT * FROM appointments WHERE status = 'Booked' AND appointmentDateTime >= ?", today);
  const past = query("SELECT * FROM appointments WHERE status = 'Booked' AND appointmentDateTime < ?", today);
  const pending = query("SELECT * FROM appointments WHERE status = 'Pending'");
  assert.ok(upcoming.length >= 2 && past.length >= 1 && pending.length >= 1);

  for (const b of upcoming) {
    assert.ok(html.includes(`/reception/${b.id}/remind`), `upcoming #${b.id} listed with a button`);
  }
  for (const b of [...past, ...pending]) {
    assert.ok(!html.includes(`/reception/${b.id}/remind`), `#${b.id} (${b.status}, ${b.appointmentDateTime}) not listed`);
  }
  assert.ok(!html.includes('Past Patient'));
  for (const expected of ['Test Patient', 'Tue, 8 Jan 2030', '10:00', 'Dentist', 'Dr. Lina Haddad', 'Send reminder']) {
    assert.ok(html.includes(expected), `page shows "${expected}"`);
  }
});

test('Send reminder emails the patient with the exact reminder text', async () => {
  const sentBefore = fakeSmtp.state.messages.length;
  const res = await remind(session.bookingId);
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), `/reception?reminded=${session.bookingId}`);

  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore + 1);
  const mail = fakeSmtp.state.messages.at(-1);
  const body = decodeMail(mail.raw);
  assert.deepStrictEqual(mail.to, ['patient@example.com']);
  assert.match(body, /^Subject: Reminder: your appointment/m);
  assert.match(body, /^From: Hadi Medical Clinic <bookings@hadiclinic\.test>/m);
  assert.ok(body.includes('Hi Test Patient, a reminder that your Dentist appointment with Dr. Lina Haddad is on Tuesday, 8 January 2030 at 10:00 at Hadi Medical Clinic, JLT. Reply to reschedule.'));
  assert.ok(body.includes('Powered by London International · lisrc.ae · built by Developer'));

  const page = await (await staffGet(res.headers.get('location'))).text();
  assert.ok(page.includes('Reminder sent to Test Patient (patient@example.com).'));
});

test('reminders can be sent again, and do not affect the confirmation email', async () => {
  const sentBefore = fakeSmtp.state.messages.length;
  await remind(session.bookingId);
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore + 1);
  assert.ok(query('SELECT confirmationEmailSentAt FROM appointments WHERE id = ?', session.bookingId)[0].confirmationEmailSentAt);
});

test('reminder for a Pending, unknown or invalid booking is refused', async () => {
  const sentBefore = fakeSmtp.state.messages.length;
  const [pending] = query("SELECT id FROM appointments WHERE status = 'Pending'");
  assert.strictEqual((await remind(pending.id)).status, 404);
  assert.strictEqual((await remind(99999)).status, 404);
  assert.strictEqual((await remind('abc')).status, 404);
  assert.strictEqual((await staffGet(`/reception/${session.bookingId}/remind`)).status, 404, 'GET does not send');
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore);
});

test('a failed reminder is logged and shown to staff', async () => {
  const sentBefore = fakeSmtp.state.messages.length;
  fakeSmtp.state.failNext = true;
  const res = await remind(session.bookingId);
  assert.strictEqual(res.headers.get('location'), `/reception?reminderFailed=${session.bookingId}`);
  assert.strictEqual(fakeSmtp.state.messages.length, sentBefore);
  assert.ok(await waitFor(() => app.getOutput().includes(`Error sending reminder email for booking ${session.bookingId}`)));

  const page = await (await staffGet(res.headers.get('location'))).text();
  assert.ok(page.includes('Could not send the reminder to Test Patient'));
});
test('staff pages stay locked when no staff password is set', async () => {
  const port = APP_PORT + 4;
  const lockedApp = await startApp({ STRIPE_SECRET_KEY: TEST_KEY, BASE_URL: `http://localhost:${port}`, STAFF_PASSWORD: '' }, port);
  try {
    const res = await fetch(`http://localhost:${port}/reception`, { headers: staffAuth('staff', '') });
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await fetch(`http://localhost:${port}/admin/bookings`)).status, 503);
  } finally {
    await stopApp(lockedApp);
  }
});
