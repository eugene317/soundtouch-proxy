const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'stations.json');

// ── Storage ────────────────────────────────────────────────────────────────

function loadStations() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveStations(stations) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(stations, null, 2));
}

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API ────────────────────────────────────────────────────────────────────

// GET all stations
app.get('/api/stations', (req, res) => {
  const stations = loadStations();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(stations.map(s => ({
    ...s,
    proxyUrl: `http://${req.get('host')}/stream/${s.id}`,
  })));
});

// POST add station
app.post('/api/stations', (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });

  const stations = loadStations();
  const id = Date.now().toString(36);
  stations.push({ id, name, url, addedAt: new Date().toISOString() });
  saveStations(stations);

  res.json({
    id, name, url,
    proxyUrl: `http://${req.get('host')}/stream/${id}`,
  });
});

// DELETE station
app.delete('/api/stations/:id', (req, res) => {
  const stations = loadStations().filter(s => s.id !== req.params.id);
  saveStations(stations);
  res.json({ ok: true });
});

// ── UPnP Helpers ───────────────────────────────────────────────────────────

function soapRequest(ip, action, body, cb) {
  const xml = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${body}</s:Body></s:Envelope>`;
  const opts = {
    hostname: ip, port: 8091,
    path: '/AVTransport/Control',
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
      'Content-Length': Buffer.byteLength(xml),
    },
  };
  const req = http.request(opts, r => { r.resume(); cb(null, r.statusCode); });
  req.on('error', cb);
  req.setTimeout(5000, () => { req.destroy(); cb(new Error('timeout')); });
  req.write(xml);
  req.end();
}

// ── UPnP Play ──────────────────────────────────────────────────────────────

app.post('/api/play', (req, res) => {
  const { speakerIp, streamUrl } = req.body;
  if (!speakerIp || !streamUrl) return res.status(400).json({ error: 'speakerIp and streamUrl required' });

  const setUri = `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>${streamUrl}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>`;
  const play   = `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>`;

  soapRequest(speakerIp, 'SetAVTransportURI', setUri, (err) => {
    if (err) return res.status(502).json({ error: `SetAVTransportURI failed: ${err.message}` });
    soapRequest(speakerIp, 'Play', play, (err2, status) => {
      if (err2) return res.status(502).json({ error: `Play failed: ${err2.message}` });
      res.json({ ok: true, status });
    });
  });
});

// ── UPnP Stop ──────────────────────────────────────────────────────────────

app.post('/api/stop', (req, res) => {
  const { speakerIp } = req.body;
  if (!speakerIp) return res.status(400).json({ error: 'speakerIp required' });

  const stop = `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Stop>`;

  soapRequest(speakerIp, 'Stop', stop, (err, status) => {
    if (err) return res.status(502).json({ error: `Stop failed: ${err.message}` });
    res.json({ ok: true, status });
  });
});

// ── Audio Proxy ────────────────────────────────────────────────────────────

// GET /stream/:id — serves the audio as HTTP for the Bose speaker
app.get('/stream/:id', (req, res) => {
  const station = loadStations().find(s => s.id === req.params.id);
  if (!station) return res.status(404).send('Station not found');

  fetchAndProxy(station.url, res);
});

// GET /proxy?url=... — direct URL proxy (no need to save station first)
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');
  fetchAndProxy(targetUrl, res);
});

function fetchAndProxy(targetUrl, res) {
  try {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Icy-MetaData': '0',
        'Connection': 'keep-alive',
      },
    };

    const upstream = lib.get(options, (upstreamRes) => {
      // Follow redirects (up to 5 hops)
      if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode)) {
        const location = upstreamRes.headers['location'];
        if (location) return fetchAndProxy(location, res);
      }

      if (upstreamRes.statusCode !== 200) {
        res.status(502).send(`Upstream returned ${upstreamRes.statusCode}`);
        return;
      }

      const contentType = upstreamRes.headers['content-type'] || 'audio/mpeg';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Transfer-Encoding', 'chunked');

      upstreamRes.pipe(res);

      req.on('close', () => upstreamRes.destroy());
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) res.status(502).send(`Proxy error: ${err.message}`);
    });

    upstream.setTimeout(10000, () => {
      upstream.destroy();
      if (!res.headersSent) res.status(504).send('Upstream timeout');
    });

  } catch (err) {
    res.status(400).send(`Invalid URL: ${err.message}`);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nSoundTouch Proxy running on port ${PORT}`);
  console.log(`Web UI:   http://localhost:${PORT}`);
  console.log(`Proxy:    http://localhost:${PORT}/stream/:id`);
  console.log(`Direct:   http://localhost:${PORT}/proxy?url=https://...`);
  console.log('');
});
