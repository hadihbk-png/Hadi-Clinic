const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

// Where the data lives:
// - TURSO_DATABASE_URL set (e.g. on Vercel): a hosted Turso (libSQL/SQLite) database,
//   shared by every Vercel instance and kept between deploys.
// - Otherwise: a local SQLite file (data/lakeside.db, or DB_PATH).
//   On Vercel without Turso that file can only go in /tmp, which is temporary.
const ON_VERCEL = Boolean(process.env.VERCEL);
const REMOTE_URL = process.env.TURSO_DATABASE_URL;

function localUrl() {
  const dbPath = process.env.DB_PATH || (ON_VERCEL
    ? path.join('/tmp', 'lakeside.db')
    : path.join(__dirname, '..', 'data', 'lakeside.db'));

  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  if (ON_VERCEL && !process.env.DB_PATH) {
    console.warn('WARNING: TURSO_DATABASE_URL is not set - using a temporary SQLite database in /tmp. ' +
      'Bookings, logins and payment records are NOT kept between restarts or shared between Vercel instances.');
  }
  return 'file:' + dbPath.replace(/\\/g, '/');
}

const client = createClient({
  url: REMOTE_URL || localUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Rows as plain objects (column name -> value)
const toObject = row => (row ? { ...row } : null);

async function columnNames(table) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.map(row => row.name);
}

// Create tables and add newer columns only if missing (keeps existing data)
async function migrate() {
  if (!REMOTE_URL) {
    await client.execute('PRAGMA journal_mode = WAL');
  }
  // Not essential (sessions are deleted explicitly), so a host that refuses it isn't fatal
  await client.execute('PRAGMA foreign_keys = ON')
    .catch(error => console.warn('Could not enable foreign keys:', error.message));

  await client.execute(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      specialty TEXT NOT NULL,
      doctor TEXT NOT NULL,
      appointmentDateTime DATETIME NOT NULL,
      patientName TEXT NOT NULL,
      patientPhone TEXT NOT NULL,
      patientEmail TEXT NOT NULL,
      status TEXT DEFAULT 'Booked',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const columns = await columnNames('appointments');
  if (!columns.includes('stripeSessionId')) {
    await client.execute('ALTER TABLE appointments ADD COLUMN stripeSessionId TEXT');
  }
  if (!columns.includes('confirmationEmailSentAt')) {
    await client.execute('ALTER TABLE appointments ADD COLUMN confirmationEmailSentAt DATETIME');
  }
  await client.execute('CREATE INDEX IF NOT EXISTS idx_appointments_stripeSessionId ON appointments (stripeSessionId)');

  // Users (staff accounts; patients default to role 'patient')
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  if (!(await columnNames('users')).includes('role')) {
    await client.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'patient'");
  }

  // Login sessions (only a hash of the cookie token is stored)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expiresAt INTEGER NOT NULL
    )
  `);
}

const ready = migrate();
ready.catch(error => console.error('Database setup failed:', error.message));

const db = {
  /** Resolves once tables are created/upgraded */
  ready,

  /**
   * Run a query and return all rows
   * @param {string} sql - SQL with ? placeholders
   * @param {...*} args - Values
   * @returns {Promise<Array>} Rows
   */
  async all(sql, ...args) {
    await ready;
    const result = await client.execute({ sql, args });
    return result.rows.map(toObject);
  },

  /**
   * Run a query and return the first row
   * @returns {Promise<Object|null>} Row or null
   */
  async get(sql, ...args) {
    await ready;
    const result = await client.execute({ sql, args });
    return toObject(result.rows[0]);
  },

  /**
   * Run an INSERT/UPDATE/DELETE
   * @returns {Promise<{changes: number, lastInsertRowid: number}>} Result
   */
  async run(sql, ...args) {
    await ready;
    const result = await client.execute({ sql, args });
    return {
      changes: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid)
    };
  },

  /** Which storage is in use (for startup logs) */
  storage: REMOTE_URL ? 'turso' : 'file'
};

module.exports = db;
