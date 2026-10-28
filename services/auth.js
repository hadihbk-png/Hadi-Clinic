const UserService = require('./userService');

const SESSION_COOKIE = 'hc_session';

/**
 * Read one cookie from the request
 * @param {Object} req - Express request
 * @param {string} name - Cookie name
 * @returns {string|null} Cookie value
 */
function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(value.join('='));
    }
  }
  return null;
}

/**
 * Set the login cookie: HttpOnly (no JavaScript access) and SameSite=Lax
 * (not sent on cross-site form posts)
 */
function setSessionCookie(req, res, token, maxAgeMs) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: maxAgeMs,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Block form posts coming from other websites
 * @returns {boolean} True if the request may continue
 */
function isSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return true;
  }
  const origin = req.get('origin');
  return !origin || origin === `${req.protocol}://${req.get('host')}`;
}

/**
 * Middleware: only logged-in users with one of the given roles may continue.
 * Not logged in: pages redirect to /login, other requests get 401.
 * @param {...string} roles - Allowed roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!isSameOrigin(req)) {
      return res.status(403).send('Cross-site request blocked');
    }

    const user = UserService.getSessionUser(readCookie(req, SESSION_COOKIE));
    if (!user) {
      if (req.method === 'GET') {
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).send('Please log in');
    }
    if (!roles.includes(user.role)) {
      return res.status(403).send('You do not have access to this page');
    }

    req.user = user;
    res.locals.user = user;
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  isSameOrigin,
  requireRole
};
