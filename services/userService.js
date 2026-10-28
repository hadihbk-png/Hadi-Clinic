const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../data/db');

const BCRYPT_ROUNDS = 12;
const SESSION_HOURS = 12;

// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
// Made on first use rather than at startup, to keep serverless cold starts fast.
let dummyHash = null;
const getDummyHash = async () => (dummyHash = dummyHash || await bcrypt.hash('not-a-real-password', BCRYPT_ROUNDS));

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

class UserService {
  /**
   * Create or update the reception staff account from .env
   * (RECEPTION_EMAIL, RECEPTION_PASSWORD). Runs on startup.
   * @returns {Promise<boolean>} True if the account is ready to log in
   */
  static async seedReceptionUser() {
    const email = (process.env.RECEPTION_EMAIL || 'reception@hadiclinic.local').trim().toLowerCase();
    const password = process.env.RECEPTION_PASSWORD;

    if (!password) {
      console.warn('RECEPTION_PASSWORD is not set in .env - the reception login is disabled');
      return false;
    }

    const existing = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!existing) {
      // OR IGNORE: another instance starting at the same moment may have just created it
      const result = await db.run("INSERT OR IGNORE INTO users (email, passwordHash, role) VALUES (?, ?, 'reception')",
        email, await bcrypt.hash(password, BCRYPT_ROUNDS));
      if (result.changes === 1) {
        console.log(`Reception user created: ${email}`);
        return true;
      }
      return UserService.seedReceptionUser();
    }

    // Keep the stored hash in step with .env, and make sure the role is right
    if (!(await bcrypt.compare(password, existing.passwordHash))) {
      await db.run('UPDATE users SET passwordHash = ? WHERE id = ?', await bcrypt.hash(password, BCRYPT_ROUNDS), existing.id);
      await db.run('DELETE FROM sessions WHERE userId = ?', existing.id); // old password's sessions end
      console.log(`Reception password updated for ${email}`);
    }
    if (existing.role !== 'reception') {
      await db.run("UPDATE users SET role = 'reception' WHERE id = ?", existing.id);
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
    const user = await db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim());
    const matches = await bcrypt.compare(String(password || ''), user ? user.passwordHash : await getDummyHash());
    if (!user || !matches) {
      return null;
    }
    return { id: user.id, email: user.email, role: user.role };
  }

  /**
   * Start a login session
   * @param {number} userId - User ID
   * @returns {Promise<{token: string, maxAgeMs: number}>} Cookie token and lifetime
   */
  static async createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAgeMs = SESSION_HOURS * 60 * 60 * 1000;
    await db.run('DELETE FROM sessions WHERE expiresAt < ?', Date.now());
    await db.run('INSERT INTO sessions (tokenHash, userId, expiresAt) VALUES (?, ?, ?)',
      hashToken(token), userId, Date.now() + maxAgeMs);
    return { token, maxAgeMs };
  }

  /**
   * Find the logged-in user for a session token
   * @param {string} token - Cookie token
   * @returns {Promise<Object|null>} User (without hash) or null
   */
  static async getSessionUser(token) {
    if (!token) {
      return null;
    }
    return db.get(`
      SELECT users.id, users.email, users.role
      FROM sessions JOIN users ON users.id = sessions.userId
      WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?
    `, hashToken(token), Date.now());
  }

  /**
   * End a login session
   * @param {string} token - Cookie token
   * @returns {Promise<void>}
   */
  static async deleteSession(token) {
    if (token) {
      await db.run('DELETE FROM sessions WHERE tokenHash = ?', hashToken(token));
    }
  }
}

module.exports = UserService;
