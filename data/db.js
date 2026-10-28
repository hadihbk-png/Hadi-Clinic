const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// On Vercel the app's own folder is read-only; /tmp is the only writable place.
// /tmp is temporary and not shared between Vercel instances, so data there
// can disappear at any time - fine for a demo, not for real bookings.
const ON_VERCEL = Boolean(process.env.VERCEL);
const DEFAULT_DB_PATH = ON_VERCEL
  ? path.join('/tmp', 'lakeside.db')
  : path.join(__dirname, '..', 'data', 'lakeside.db');
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;
const DATA_DIR = path.dirname(DB_PATH);

if (ON_VERCEL && !process.env.DB_PATH) {
  console.warn('WARNING: running on Vercel with a temporary SQLite database in /tmp - ' +
    'bookings, logins and payments records are NOT kept between restarts or shared between instances.');
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Open database
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and other pragmas
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Create appointments table if it doesn't exist
const createTableSQL = `
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
`;

db.exec(createTableSQL);

// Add newer columns to existing databases (keeps existing bookings)
const columns = db.prepare('PRAGMA table_info(appointments)').all();
if (!columns.some(column => column.name === 'stripeSessionId')) {
  db.exec('ALTER TABLE appointments ADD COLUMN stripeSessionId TEXT');
}
if (!columns.some(column => column.name === 'confirmationEmailSentAt')) {
  db.exec('ALTER TABLE appointments ADD COLUMN confirmationEmailSentAt DATETIME');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_appointments_stripeSessionId ON appointments (stripeSessionId)');

// Users (staff accounts; patients default to role 'patient')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some(column => column.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'patient'");
}

// Login sessions (only a hash of the cookie token is stored)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expiresAt INTEGER NOT NULL
  )
`);

module.exports = db;
