const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lakeside.db');
const DATA_DIR = path.dirname(DB_PATH);

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

module.exports = db;
