const express = require('express');
const router = express.Router();
const AssistantService = require('../services/assistantService');

const FALLBACK = 'Sorry, the assistant is unavailable right now. Please call us on +971 4 123 4567.';

// Simple in-memory limit per visitor: each reply costs money
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter(time => now - time < WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length > MAX_REQUESTS_PER_WINDOW;
}

// Drop visitors with no recent requests so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of requestLog) {
    if (times.every(time => now - time >= WINDOW_MS)) requestLog.delete(ip);
  }
}, WINDOW_MS).unref();

// POST /api/chat - { messages: [{ role: 'user'|'assistant', content }] } -> { reply }
router.post('/chat', express.json({ limit: '32kb' }), async (req, res) => {
  if (isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'You are sending messages too quickly. Please wait a few minutes.' });
  }

  try {
    const reply = await AssistantService.reply(req.body && req.body.messages);
    res.json({ reply });
  } catch (error) {
    if (error instanceof AssistantService.InvalidConversationError) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof AssistantService.RateLimitError) {
      console.error('Assistant rate limited by the AI provider');
    } else if (error instanceof AssistantService.AuthenticationError) {
      console.error('Assistant error: invalid ANTHROPIC_API_KEY');
    } else if (error instanceof AssistantService.APIConnectionError) {
      console.error('Assistant error: could not reach the AI provider');
    } else if (error instanceof AssistantService.APIError) {
      console.error(`Assistant API error ${error.status}:`, error.message);
    } else {
      console.error('Assistant error:', error.message);
    }
    res.status(503).json({ error: FALLBACK });
  }
});

module.exports = router;
