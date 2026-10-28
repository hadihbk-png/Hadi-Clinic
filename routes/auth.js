const express = require('express');
const router = express.Router();
const UserService = require('../services/userService');
const { SESSION_COOKIE, readCookie, setSessionCookie, clearSessionCookie, isSameOrigin } = require('../services/auth');

// Slow down password guessing: max failed logins per visitor per window
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map();

function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter(time => now - time < WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= MAX_FAILURES;
}

// Only redirect to pages on this site after login (no open redirects)
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/reception';
}

// GET /login - staff login form
router.get('/login', (req, res) => {
  res.render('login', { error: null, email: '', next: safeNext(req.query.next) });
});

// POST /login - check email and password, start a session
router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const next = safeNext(req.body.next);
  const email = String(req.body.email || '').trim();

  if (!isSameOrigin(req)) {
    return res.status(403).send('Cross-site request blocked');
  }
  if (tooManyFailures(req.ip)) {
    return res.status(429).render('login', { error: 'Too many failed attempts. Please wait 15 minutes and try again.', email, next });
  }

  const user = await UserService.verifyLogin(email, req.body.password);
  if (!user) {
    failures.get(req.ip).push(Date.now());
    return res.status(401).render('login', { error: 'Incorrect email or password.', email, next });
  }

  failures.delete(req.ip);
  const { token, maxAgeMs } = await UserService.createSession(user.id);
  setSessionCookie(req, res, token, maxAgeMs);
  res.redirect(303, next);
});

// POST /logout - end the session
router.post('/logout', async (req, res) => {
  await UserService.deleteSession(readCookie(req, SESSION_COOKIE));
  clearSessionCookie(res);
  res.redirect(303, '/login');
});

module.exports = router;
