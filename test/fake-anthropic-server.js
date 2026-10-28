// Local stand-in for the Claude Messages API (POST /v1/messages) for tests.
// Records each request; set `state.next` to control the next response:
//   { text } | { refusal: true } | { status, error }
// or `state.fail = { count, status, error }` to fail the next `count` requests.
const http = require('http');

function startFakeAnthropic(port = 12112) {
  const state = { requests: [], next: null, fail: null };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_fake' });
        res.end(JSON.stringify(obj));
      };

      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        return send(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
      }
      // SDK 1.x sends "Authorization: Bearer <key>"; older SDKs send x-api-key
      req.headers['x-api-key'] = req.headers['x-api-key'] ||
        (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!req.headers['x-api-key']) {
        return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }

      const params = JSON.parse(body);
      state.requests.push({ params, headers: req.headers });
      let next = state.next || {};
      state.next = null;
      if (state.fail && state.fail.count > 0) {
        state.fail.count--;
        next = state.fail;
      }

      if (next.status) {
        return send(next.status, { type: 'error', error: { type: next.error || 'api_error', message: 'Simulated error' } });
      }

      const lastUser = params.messages.at(-1).content;
      const content = next.refusal ? [] : [
        // Real Haiku 5.5 responses can start with a thinking block (empty text by default)
        { type: 'thinking', thinking: '', signature: 'fake-signature' },
        { type: 'text', text: next.text ?? `You asked: ${lastUser}` }
      ];
      send(200, {
        id: `msg_fake_${state.requests.length}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content,
        stop_reason: next.refusal ? 'refusal' : 'end_turn',
        stop_sequence: null,
        stop_details: next.refusal ? { type: 'refusal', category: null, explanation: null } : null,
        usage: { input_tokens: 10, output_tokens: 10 }
      });
    });
  });

  return new Promise(resolve => server.listen(port, () => resolve({ server, state, port })));
}

module.exports = { startFakeAnthropic };
