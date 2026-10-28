// Minimal local SMTP server for tests: accepts mail and keeps it in memory.
// Set `failNext = true` to reject the next message (simulates a mail outage).
const net = require('net');

function startFakeSmtp(port = 2525) {
  const state = { messages: [], failNext: false };

  const server = net.createServer(socket => {
    let mail = null;
    let inData = false;
    let buffer = '';
    let authStep = null;
    const reply = line => socket.write(`${line}\r\n`);

    reply('220 localhost fake SMTP ready');

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');

      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          mail.raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          inData = false;
          state.messages.push(mail);
          reply('250 OK message accepted');
          continue;
        }

        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);

        if (authStep) {
          authStep = authStep === 'user' ? 'pass' : null;
          reply(authStep ? '334 UGFzc3dvcmQ6' : '235 Authentication successful');
          continue;
        }

        const command = line.split(' ')[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (command === 'AUTH') {
          if (/^AUTH PLAIN \S+/i.test(line)) {
            reply('235 Authentication successful');
          } else {
            authStep = 'user';
            reply('334 VXNlcm5hbWU6');
          }
        } else if (command === 'MAIL') {
          if (state.failNext) {
            state.failNext = false;
            reply('550 Simulated mail server failure');
          } else {
            mail = { from: line.match(/<(.*)>/)?.[1], to: [] };
            reply('250 OK');
          }
        } else if (command === 'RCPT') {
          mail.to.push(line.match(/<(.*)>/)?.[1]);
          reply('250 OK');
        } else if (command === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (command === 'RSET') {
          mail = null;
          reply('250 OK');
        } else if (command === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else {
          reply('250 OK');
        }
      }
    });
    socket.on('error', () => {});
  });

  return new Promise(resolve => {
    server.listen(port, () => resolve({ server, state, port }));
  });
}

module.exports = { startFakeSmtp };
