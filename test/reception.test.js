// Tests for the reception dashboard: login, role check, today's appointments
// (Asia/Dubai), status buttons and reminders. Runs the real server.js on a
// throwaway database with a fake SMTP server. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { startFakeSmtp } = require('./fake-smtp-server');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 3305;
const SMTP_PORT = 2526;
const BASE_URL = `http://localhost:${APP_PORT}`;
const EMAIL = 'reception@test.local';
const PASSWORD = 'correct-horse-battery';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hadi-clinic-reception-test-'));
const dbPath = path.join(tmpDir, 'test.db');

// The server runs in Honolulu time (UTC-10) to prove "today" is computed in Dubai (UTC+4)
const SERVER_TZ = 'Pacific/Honolulu';
const dubaiDate = (offsetDays = 0) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
};
const TODAY = dubaiDate(0);

let fakeSmtp;
let app;

function startApp(env = {}, port = APP_PORT, db = dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        TZ: SERVER_TZ,
        PORT: String(port),
        DB_PATH: db,
        RECEPTION_EMAIL: EMAIL,
        RECEPTION_PASSWORD: PASSWORD,
        BUILT_BY: 'Hadi Test',
        SMTP_HOST: 'localhost',
        SMTP_PORT: String(SMTP_PORT),
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        SMTP_FROM: 'bookings@hadiclinic.test',
        ...env
      }
    });
    let output = '';
    child.getOutput = () => output;
    let started = false;
    child.stdout.on('data', d => {
      output += d;
      if (!started && output.includes('Server running')) {
        started = true;
        // Pages wait for the database setup, so one request means tables and the reception user exist
        fetch(`http://localhost:${port}/login`).then(() => resolve(child), reject);
      }
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

function sql(statement, ...params) {
  const db = new DatabaseSync(dbPath);
  try {
    const stmt = db.prepare(statement);
    return /^\s*select|^\s*pragma/i.test(statement) ? stmt.all(...params) : stmt.run(...params);
  } finally {
    db.close();
  }
}

function addAppointment(doctor, specialty, date, time, patientName, status, email = 'p@example.com') {
  return Number(sql(`INSERT INTO appointments (specialty, doctor, appointmentDateTime, patientName, patientPhone, patientEmail, status)
    VALUES (?, ?, ?, ?, '0500000000', ?, ?)`, specialty, doctor, `${date} ${time}`, patientName, email, status).lastInsertRowid);
}

async function login(email = EMAIL, password = PASSWORD, base = BASE_URL, next) {
  const body = new URLSearchParams({ email, password, ...(next ? { next } : {}) });
  return fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
}

const cookieFrom = res => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
let staffCookie;
const staffGet = (pathname, cookie = staffCookie) => fetch(`${BASE_URL}${pathname}`, { redirect: 'manual', headers: { Cookie: cookie } });
const staffPost = (pathname, form = {}, headers = {}, cookie = staffCookie) => fetch(`${BASE_URL}${pathname}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(form)
});

const ids = {};

before(async () => {
  fakeSmtp = await startFakeSmtp(SMTP_PORT);
  app = await startApp();

  ids.saraBooked = addAppointment('Dr. Sara Ahmed', 'General Physician', TODAY, '09:30', 'Amira Today', 'Booked', 'amira@example.com');
  ids.saraArrived = addAppointment('Dr. Sara Ahmed', 'General Physician', TODAY, '11:00', 'Bilal Today', 'Arrived');
  ids.linaBooked = addAppointment('Dr. Lina Haddad', 'Dentist', TODAY, '10:00', 'Chen Today', 'Booked');
  ids.pendingToday = addAppointment('Dr. Lina Haddad', 'Dentist', TODAY, '12:00', 'Unpaid Today', 'Pending');
  ids.yesterday = addAppointment('Dr. Sara Ahmed', 'General Physician', dubaiDate(-1), '23:30', 'Yesterday Patient', 'Booked');
  ids.tomorrow = addAppointment('Dr. Raj Mehta', 'Cardiologist', dubaiDate(1), '00:30', 'Tomorrow Patient', 'Booked', 'tomorrow@example.com');
});

after(async () => {
  if (app) await stopApp(app);
  if (fakeSmtp) fakeSmtp.server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('users table has a role column (default patient) and the reception user is seeded, hashed', () => {
  const role = sql('PRAGMA table_info(users)').find(c => c.name === 'role');
  assert.ok(role, 'role column exists');
  assert.strictEqual(role.dflt_value, "'patient'");

  const [user] = sql('SELECT * FROM users WHERE email = ?', EMAIL);
  assert.strictEqual(user.role, 'reception');
  assert.match(user.passwordHash, /^\$2[aby]\$12\$/, 'bcrypt hash, cost 12');
  assert.ok(!user.passwordHash.includes(PASSWORD));
  assert.ok(bcrypt.compareSync(PASSWORD, user.passwordHash));
});

test('not logged in: /reception and /admin/bookings redirect to login, actions are refused', async () => {
  for (const page of ['/reception', '/admin/bookings']) {
    const res = await fetch(`${BASE_URL}${page}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), `/login?next=${encodeURIComponent(page)}`);
  }
  assert.strictEqual((await staffPost(`/reception/${ids.saraBooked}/status`, { status: 'Arrived' }, {}, '')).status, 401);
  assert.strictEqual((await staffPost(`/reception/${ids.saraBooked}/remind`, {}, {}, '')).status, 401);
  assert.strictEqual(sql('SELECT status FROM appointments WHERE id = ?', ids.saraBooked)[0].status, 'Booked');
  assert.strictEqual((await fetch(`${BASE_URL}/login`)).status, 200);
});

test('wrong password or unknown email is refused', async () => {
  for (const [email, password] of [[EMAIL, 'wrong-password'], ['nobody@test.local', PASSWORD], [EMAIL, '']]) {
    const res = await login(email, password);
    assert.strictEqual(res.status, 401);
    assert.ok((await res.text()).includes('Incorrect email or password.'));
    assert.deepStrictEqual(res.headers.getSetCookie(), []);
  }
});

test('a logged-in user without the reception role gets 403', async () => {
  sql("INSERT INTO users (email, passwordHash) VALUES ('patient@test.local', ?)", bcrypt.hashSync('patient-pass', 4));
  assert.strictEqual(sql("SELECT role FROM users WHERE email = 'patient@test.local'")[0].role, 'patient', 'default role');

  const res = await login('patient@test.local', 'patient-pass');
  assert.strictEqual(res.status, 303);
  const cookie = cookieFrom(res);
  assert.strictEqual((await staffGet('/reception', cookie)).status, 403);
  assert.strictEqual((await staffGet('/admin/bookings', cookie)).status, 403);
  assert.strictEqual((await staffPost(`/reception/${ids.saraBooked}/status`, { status: 'Done' }, {}, cookie)).status, 403);
});

test('reception login sets a secure session cookie and opens the dashboard', async () => {
  const res = await login();
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/reception');
  const [setCookie] = res.headers.getSetCookie();
  assert.match(setCookie, /^hc_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  staffCookie = cookieFrom(res);

  assert.strictEqual((await staffGet('/reception')).status, 200);
  assert.strictEqual((await staffGet('/admin/bookings')).status, 200);
});

test('login only redirects to pages on this site', async () => {
  for (const [next, expected] of [['/admin/bookings', '/admin/bookings'], ['//evil.example', '/reception'], ['https://evil.example', '/reception']]) {
    const res = await login(EMAIL, PASSWORD, BASE_URL, next);
    assert.strictEqual(res.headers.get('location'), expected);
  }
});

test("dashboard shows today's appointments (Dubai date) grouped by doctor, with a count", async () => {
  const html = await (await staffGet('/reception')).text();

  assert.match(html, /<span class="count" id="todayCount">3<\/span>/, 'Pending excluded from the count');
  for (const name of ['Amira Today', 'Bilal Today', 'Chen Today']) {
    assert.ok(html.includes(name), `today: ${name}`);
  }
  assert.ok(!html.includes('Unpaid Today'), 'unpaid Pending not shown');
  assert.ok(!html.includes('Yesterday Patient'), 'yesterday (Dubai) not shown');

  // Grouped by doctor: Dr. Lina Haddad's card, then Dr. Sara Ahmed's with both her patients in time order
  // Doctor card headings (the doctor's name directly after the badge icon)
  const cardStart = name => html.search(new RegExp(`bi-person-badge"></i> ${name}\\s*<small`));
  const lina = cardStart('Dr. Lina Haddad'), sara = cardStart('Dr. Sara Ahmed');
  assert.ok(lina !== -1 && sara !== -1 && lina < sara, 'one card per doctor');
  const saraCard = html.slice(sara);
  assert.ok(saraCard.indexOf('Amira Today') < saraCard.indexOf('Bilal Today'));
  assert.ok(html.slice(lina, sara).includes('Chen Today') && !html.slice(lina, sara).includes('Amira Today'));

  // Row details: name, time, specialty, status
  const amiraRow = html.slice(html.indexOf('Amira Today'), html.indexOf('</tr>', html.indexOf('Amira Today')));
  for (const part of ['09:30', 'General Physician', 'status-booked">Booked']) {
    assert.ok(amiraRow.includes(part), `row has ${part}`);
  }
  for (const status of ['Arrived', 'Done', 'No-show']) {
    assert.ok(amiraRow.includes(`value="${status}"`), `${status} button`);
  }
  assert.ok(amiraRow.includes('Send reminder'));

  // Tomorrow's appointment is in the upcoming list, not today's
  const upcoming = html.slice(html.indexOf('Upcoming (from tomorrow)'));
  assert.ok(upcoming.includes('Tomorrow Patient'));
  assert.ok(html.indexOf('Tomorrow Patient') > html.indexOf('Upcoming (from tomorrow)'));
});

test('header shows the clinic label and the builder name in the corner', async () => {
  const html = await (await staffGet('/reception')).text();
  assert.ok(html.includes('Hadi Clinic Reception — London International · lisrc.ae'));
  assert.match(html, /<div class="builder-corner">by Hadi Test<\/div>/);
});

test('Arrived, Done and No-show update the database', async () => {
  for (const status of ['Arrived', 'Done', 'No-show']) {
    const res = await staffPost(`/reception/${ids.linaBooked}/status`, { status });
    assert.strictEqual(res.status, 303);
    assert.strictEqual(res.headers.get('location'), `/reception?updated=${ids.linaBooked}`);
    assert.strictEqual(sql('SELECT status FROM appointments WHERE id = ?', ids.linaBooked)[0].status, status);
  }
  const html = await (await staffGet(`/reception?updated=${ids.linaBooked}`)).text();
  assert.ok(html.includes('Chen Today marked as No-show.'));
  assert.ok(html.includes('status-no-show">No-show'));
});

test('invalid status, unknown or unpaid appointment is refused', async () => {
  assert.strictEqual((await staffPost(`/reception/${ids.saraBooked}/status`, { status: 'Cancelled' })).status, 400);
  assert.strictEqual((await staffPost(`/reception/${ids.saraBooked}/status`, { status: 'Booked' })).status, 400);
  assert.strictEqual((await staffPost('/reception/99999/status', { status: 'Done' })).status, 400);
  assert.strictEqual((await staffPost(`/reception/${ids.pendingToday}/status`, { status: 'Arrived' })).status, 400);
  assert.strictEqual(sql('SELECT status FROM appointments WHERE id = ?', ids.pendingToday)[0].status, 'Pending');
  assert.strictEqual(sql('SELECT status FROM appointments WHERE id = ?', ids.saraBooked)[0].status, 'Booked');
});

test('Send reminder still works for today and upcoming Booked appointments', async () => {
  for (const [id, email] of [[ids.saraBooked, 'amira@example.com'], [ids.tomorrow, 'tomorrow@example.com']]) {
    const before = fakeSmtp.state.messages.length;
    const res = await staffPost(`/reception/${id}/remind`);
    assert.strictEqual(res.headers.get('location'), `/reception?reminded=${id}`);
    assert.strictEqual(fakeSmtp.state.messages.length, before + 1);
    assert.deepStrictEqual(fakeSmtp.state.messages.at(-1).to, [email]);
  }
  // Not Booked (Arrived) -> no reminder
  assert.strictEqual((await staffPost(`/reception/${ids.saraArrived}/remind`)).status, 404);
});

test('a status change posted from another site is blocked', async () => {
  const res = await staffPost(`/reception/${ids.saraBooked}/status`, { status: 'No-show' }, { Origin: 'https://evil.example' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(sql('SELECT status FROM appointments WHERE id = ?', ids.saraBooked)[0].status, 'Booked');
});

test('log out ends the session', async () => {
  const res = await login();
  const cookie = cookieFrom(res);
  assert.strictEqual((await staffGet('/reception', cookie)).status, 200);
  const out = await staffPost('/logout', {}, {}, cookie);
  assert.strictEqual(out.headers.get('location'), '/login');
  assert.strictEqual((await staffGet('/reception', cookie)).status, 302, 'old cookie no longer works');
  assert.strictEqual((await staffGet('/reception')).status, 200, 'other sessions unaffected');
});

test('changing RECEPTION_PASSWORD in .env updates the hash and ends old sessions', async () => {
  await stopApp(app);
  app = await startApp({ RECEPTION_PASSWORD: 'a-new-password-123' });
  try {
    assert.ok(app.getOutput().includes(`Reception password updated for ${EMAIL}`));
    assert.strictEqual((await login(EMAIL, PASSWORD)).status, 401, 'old password refused');
    assert.strictEqual((await staffGet('/reception')).status, 302, 'old session ended');
    const res = await login(EMAIL, 'a-new-password-123');
    assert.strictEqual(res.status, 303);
    staffCookie = cookieFrom(res);
    assert.strictEqual(sql('SELECT COUNT(*) AS n FROM users WHERE email = ?', EMAIL)[0].n, 1, 'still one reception user');
  } finally {
    await stopApp(app);
    app = await startApp();
  }
});

test('no RECEPTION_PASSWORD: no login possible', async () => {
  const port = APP_PORT + 1;
  const db = path.join(tmpDir, 'nopass.db');
  const noPassApp = await startApp({ RECEPTION_PASSWORD: '' }, port, db);
  try {
    assert.ok(noPassApp.getOutput().includes('RECEPTION_PASSWORD is not set'));
    assert.strictEqual((await login(EMAIL, '', `http://localhost:${port}`)).status, 401);
    assert.strictEqual((await login(EMAIL, PASSWORD, `http://localhost:${port}`)).status, 401);
  } finally {
    await stopApp(noPassApp);
  }
});

test('an existing users table without role gets the column, keeping its rows', async () => {
  const port = APP_PORT + 2;
  const db = path.join(tmpDir, 'oldusers.db');
  const old = new DatabaseSync(db);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  old.prepare("INSERT INTO users (email, passwordHash) VALUES ('old@test.local', 'x')").run();
  old.close();

  const oldApp = await startApp({}, port, db);
  await stopApp(oldApp);
  const check = new DatabaseSync(db);
  const rows = check.prepare('SELECT email, role FROM users ORDER BY id').all();
  check.close();
  assert.deepStrictEqual(rows.map(r => ({ ...r })), [
    { email: 'old@test.local', role: 'patient' },
    { email: EMAIL, role: 'reception' }
  ]);
});

test('too many failed logins are slowed down', async () => {
  const port = APP_PORT + 3;
  const limitedApp = await startApp({}, port, path.join(tmpDir, 'limit.db'));
  try {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await login(EMAIL, `wrong-${i}`, `http://localhost:${port}`)).status);
    }
    assert.deepStrictEqual(statuses, [...Array(10).fill(401), 429]);
    assert.strictEqual((await login(EMAIL, PASSWORD, `http://localhost:${port}`)).status, 429, 'locked even with the right password');
  } finally {
    await stopApp(limitedApp);
  }
});
