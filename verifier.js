import dns from 'dns';
import net from 'net';
import { log } from './utils.js';

const CATCH_ALL_SMTP_CODES = [250, 251];
const CATCH_ALL_TEST_ADDRESS = 'definitely_not_real_xQz9@';

export async function verifyEmail(email) {
  if (!email || !email.includes('@')) return 'not_found';

  const domain = email.split('@')[1];

  const hasMx = await checkMxRecord(domain);
  if (!hasMx) {
    log(`No MX record for domain: ${domain}`);
    return 'not_found';
  }

  const smtpResult = await checkSmtp(email, domain);
  return smtpResult;
}

function checkMxRecord(domain) {
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

async function checkSmtp(email, domain) {
  const mxHost = await getMxHost(domain);
  if (!mxHost) return 'risky';

  try {
    const targetResult = await smtpCheck(email, mxHost);
    const catchAllResult = await smtpCheck(`${CATCH_ALL_TEST_ADDRESS}${domain}`, mxHost);

    if (catchAllResult === 250) {
      return 'risky';
    }

    if (targetResult === 250 || targetResult === 251) {
      return 'verified';
    }

    if (targetResult === 550 || targetResult === 551 || targetResult === 553) {
      return 'not_found';
    }

    return 'risky';
  } catch (_) {
    return 'risky';
  }
}

function getMxHost(domain) {
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolve(null);
      } else {
        const sorted = addresses.sort((a, b) => a.priority - b.priority);
        resolve(sorted[0].exchange);
      }
    });
  });
}

function smtpCheck(email, mxHost) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let resultCode = null;

    const TIMEOUT = 8000;
    socket.setTimeout(TIMEOUT);

    const sendCommand = (cmd) => {
      try { socket.write(cmd + '\r\n'); } catch (_) {}
    };

    socket.connect(25, mxHost, () => {});

    socket.on('data', (data) => {
      const response = data.toString();
      const code = parseInt(response.substring(0, 3), 10);

      if (step === 0 && code === 220) {
        step = 1;
        sendCommand('EHLO leadengine.check');
      } else if (step === 1 && (code === 250 || code === 220)) {
        step = 2;
        sendCommand('MAIL FROM:<verify@leadengine.check>');
      } else if (step === 2 && code === 250) {
        step = 3;
        sendCommand(`RCPT TO:<${email}>`);
      } else if (step === 3) {
        resultCode = code;
        sendCommand('QUIT');
        socket.destroy();
        resolve(resultCode);
      } else if (code >= 400) {
        socket.destroy();
        resolve(code);
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });

    socket.on('error', () => {
      resolve(null);
    });

    socket.on('close', () => {
      if (resultCode === null) resolve(null);
    });
  });
}
