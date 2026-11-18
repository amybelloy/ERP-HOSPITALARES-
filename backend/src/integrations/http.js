'use strict';
/** Cliente HTTP com suporte a mTLS (certificado de cliente) e timeout, usado pelos adaptadores reais. */
const https = require('https');
const fs = require('fs');
const { providerError } = require('../lib/errors');

function buildAgent({ certPath, keyPath, pfxPath, passphrase }) {
  const opts = { keepAlive: true };
  if (pfxPath) opts.pfx = fs.readFileSync(pfxPath);
  if (certPath) opts.cert = fs.readFileSync(certPath);
  if (keyPath) opts.key = fs.readFileSync(keyPath);
  if (passphrase) opts.passphrase = passphrase;
  return new https.Agent(opts);
}

function request(url, { method = 'GET', headers = {}, body, agent, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request(url, {
      method, agent,
      headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': headers['Content-Type'] || 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { json = { raw: data }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(providerError(`Falha de comunicação com o provedor: ${err.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { buildAgent, request };
