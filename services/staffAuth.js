const crypto = require('crypto');

/**
 * Compare two strings in constant time
 * @param {string} a - First value
 * @param {string} b - Second value
 * @returns {boolean} True if equal
 */
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Express middleware protecting staff pages with HTTP Basic auth.
 * Username and password come from STAFF_USER and STAFF_PASSWORD in .env.
 * Fails closed: if no password is set, nobody gets in.
 */
function requireStaff(req, res, next) {
  const expectedUser = process.env.STAFF_USER || 'staff';
  const expectedPassword = process.env.STAFF_PASSWORD;

  if (!expectedPassword) {
    return res.status(503).send('Staff pages are locked: set STAFF_PASSWORD in .env');
  }

  // Block cross-site form posts (browsers send Basic credentials automatically)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).send('Cross-site request blocked');
    }
  }

  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    // Check both, always, so timing does not reveal which one was wrong
    const userOk = safeEqual(user, expectedUser);
    const passwordOk = safeEqual(password, expectedPassword);
    if (separator !== -1 && userOk && passwordOk) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Hadi Medical Clinic staff", charset="UTF-8"');
  res.status(401).send('Staff login required');
}

module.exports = { requireStaff };
