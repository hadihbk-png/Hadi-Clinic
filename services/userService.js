const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../data/db');

const BCRYPT_ROUNDS = 12;
const SESSION_HOURS = 12;

// Compared against when the email is unknown, so timing doesn't reveal which emails exist
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

class UserService {
  /**
   * Create or update the reception staff account from .env
   * (RECEPTION_EMAIL, RECEPTION_PASSWORD). Runs on startup.
   * @returns {boolean} True if the account is ready to log in
   */
  static seedReceptionUser() {
    const email = (process.env.RECEPTION_EMAIL || 'reception@hadiclinic.local').trim().toLowerCase();
    const password = process.env.RECEPTION_PASSWORD;

    if (!password) {
      console.warn('RECEPTION_PASSWORD is not set in .env - the reception login is disabled');
      return false;
    }

    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!existing) {
      db.prepare("INSERT INTO users (email, passwordHash, role) VALUES (?, ?, 'reception')")
        .run(email, bcrypt.hashSync(password, BCRYPT_ROUNDS));
      console.log(`Reception user created: ${email}`);
      return true;
    }

    // Keep the stored hash in step with .env, and make sure the role is right
    if (!bcrypt.compareSync(password, existing.passwordHash)) {
      db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?')
        .run(bcrypt.hashSync(password, BCRYPT_ROUNDS), existing.id);
      db.prepare('DELETE FROM sessions WHERE userId = ?').run(existing.id); // old password's sessions end
      console.log(`Reception password updated for ${email}`);
    }
    if (existing.role !== 'reception') {
      db.prepare("UPDATE users SET role = 'reception' WHERE id = ?").run(existing.id);
    }
    return true;
  }

  /**
   * Check an email and password
   * @param {string} email - Email address
   * @param {string} password - Plain-text password
   * @returns {Promise<Object|null>} User (without hash) or null
   */
  static async verifyLogin(email, password) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
    const matches = await bcrypt.compare(String(password || ''), user ? user.passwordHash : DUMMY_HASH);
    if (!user || !matches) {
      return null;
    }
    return { id: user.id, email: user.email, role: user.role };
  }

  /**
   * Start a login session
   * @param {number} userId - User ID
   * @returns {{token: string, maxAgeMs: number}} Cookie token and lifetime
   */
  static createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAgeMs = SESSION_HOURS * 60 * 60 * 1000;
    db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now() + maxAgeMs);
    return { token, maxAgeMs };
  }

  /**
   * Find the logged-in user for a session token
   * @param {string} token - Cookie token
   * @returns {Object|null} User (without hash) or null
   */
  static getSessionUser(token) {
    if (!token) {
      return null;
    }
    return db.prepare(`
      SELECT users.id, users.email, users.role
      FROM sessions JOIN users ON users.id = sessions.userId
      WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?
    `).get(hashToken(token), Date.now()) || null;
  }

  /**
   * End a login session
   * @param {string} token - Cookie token
   */
  static deleteSession(token) {
    if (token) {
      db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(hashToken(token));
    }
  }
}

module.exports = UserService;
