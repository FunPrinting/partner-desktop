'use strict';
const http = require('node:http');
const ipp = require('../../src/print/ipp');

/**
 * A small IPP Everywhere-style printer for tests (and for trying the app without
 * hardware): answers Get-Printer-Attributes, Validate-Job, Print-Job, Get-Job-Attributes,
 * Get-Jobs and Cancel-Job over HTTP. Print jobs are kept in memory (`jobs`).
 */
const T = ipp.Tag;
const OP = { Print: 0x0002, Validate: 0x0004, Cancel: 0x0008, GetJob: 0x0009, GetJobs: 0x000a, GetPrinter: 0x000b };
const FORMATS = ['application/pdf', 'image/pwg-raster', 'image/urf', 'image/jpeg', 'application/octet-stream'];

const raw = (tag, name, value) => {
  const n = Buffer.from(name);
  const head = Buffer.alloc(3);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(n.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(value.length);
  return Buffer.concat([head, n, len, value]);
};
const int32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return b;
};
const resolution = (x, y) => Buffer.concat([int32(x), int32(y), Buffer.from([3])]); // 3 = dots per inch

function createFakeIppPrinter({ name = 'FP Fake IPP', color = true, duplex = false, media = ['iso_a4_210x297mm'], host = '127.0.0.1', port = 0, rp = 'ipp/print' } = {}) {
  const jobs = [];
  let state = 3; // idle
  const uuid = 'urn:uuid:11111111-2222-3333-4444-555555555555';
  let boundPort = port;
  const uri = (scheme = 'ipp') => `${scheme}://${host}:${boundPort}/${rp}`;

  function printerAttrs(requestHost) {
    const base = `ipp://${requestHost || `${host}:${boundPort}`}/${rp}`;
    const p = [
      ipp.attr(T.uri, 'printer-uri-supported', base),
      ipp.attr(T.keyword, 'uri-security-supported', 'none'),
      ipp.attr(T.keyword, 'uri-authentication-supported', 'none'),
      ipp.attr(T.name, 'printer-name', name),
      ipp.attr(T.text, 'printer-info', name),
      ipp.attr(T.text, 'printer-location', ''),
      ipp.attr(T.text, 'printer-make-and-model', 'FunPrinting Fake IPP 1.0'),
      ipp.attr(T.text, 'printer-device-id', 'MFG:FunPrinting;MDL:Fake IPP;CMD:PWGRaster,URF;'),
      ipp.attr(T.uri, 'printer-uuid', uuid),
      ipp.attr(T.enum, 'printer-state', state),
      ipp.attr(T.keyword, 'printer-state-reasons', 'none'),
      ipp.attr(T.boolean, 'printer-is-accepting-jobs', true),
      ipp.attr(T.keyword, 'ipp-versions-supported', ['1.1', '2.0']),
      ipp.attr(T.enum, 'operations-supported', [OP.Print, OP.Validate, OP.Cancel, OP.GetJob, OP.GetJobs, OP.GetPrinter]),
      ipp.attr(T.charset, 'charset-configured', 'utf-8'),
      ipp.attr(T.charset, 'charset-supported', 'utf-8'),
      ipp.attr(T.language, 'natural-language-configured', 'en'),
      ipp.attr(T.language, 'generated-natural-language-supported', 'en'),
      ipp.attr(T.mime, 'document-format-default', 'application/pdf'),
      ipp.attr(T.mime, 'document-format-supported', FORMATS),
      ipp.attr(T.boolean, 'color-supported', color),
      ipp.attr(T.keyword, 'print-color-mode-supported', color ? ['color', 'monochrome', 'auto'] : ['monochrome']),
      ipp.attr(T.keyword, 'print-color-mode-default', color ? 'auto' : 'monochrome'),
      ipp.attr(T.keyword, 'sides-supported', duplex ? ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] : ['one-sided']),
      ipp.attr(T.keyword, 'sides-default', 'one-sided'),
      ipp.attr(T.keyword, 'media-supported', media),
      ipp.attr(T.keyword, 'media-default', media[0]),
      ipp.attr(T.keyword, 'media-ready', media[0]),
      ipp.attr(T.integer, 'copies-default', 1),
      raw(0x33, 'copies-supported', Buffer.concat([int32(1), int32(99)])),
      ipp.attr(T.integer, 'queued-job-count', 0),
      ipp.attr(T.keyword, 'pdl-override-supported', 'attempted'),
      ipp.attr(T.integer, 'pages-per-minute', 10),
      ipp.attr(T.keyword, 'compression-supported', 'none'),
      ipp.attr(T.keyword, 'job-creation-attributes-supported', ['copies', 'sides', 'media', 'print-color-mode', 'orientation-requested']),
      ipp.attr(T.enum, 'orientation-requested-supported', [3, 4, 5, 6]),
      ipp.attr(T.enum, 'orientation-requested-default', 3),
      ipp.attr(T.boolean, 'multiple-document-jobs-supported', false),
      ipp.attr(T.integer, 'printer-up-time', Math.floor(process.uptime())),
      ipp.attr(T.keyword, 'printer-get-attributes-supported', 'document-format'),
      raw(0x32, 'printer-resolution-default', resolution(300, 300)),
      raw(0x32, 'printer-resolution-supported', resolution(300, 300)),
      ipp.attr(T.keyword, 'urf-supported', ['V1.4', 'CP1', 'W8', 'RS300']),
      ipp.attr(T.keyword, 'pwg-raster-document-type-supported', ['sgray_8', 'srgb_8']),
      raw(0x32, 'pwg-raster-document-resolution-supported', resolution(300, 300)),
      ipp.attr(T.keyword, 'pwg-raster-document-sheet-back', 'normal'),
    ];
    return p;
  }

  function jobGroup(job) {
    return Buffer.concat([
      Buffer.from([0x02]),
      ipp.attr(T.integer, 'job-id', job.id),
      ipp.attr(T.uri, 'job-uri', `${uri()}/job/${job.id}`),
      ipp.attr(T.enum, 'job-state', job.state),
      ipp.attr(T.keyword, 'job-state-reasons', job.state === 9 ? 'job-completed-successfully' : 'none'),
    ]);
  }

  function respond(requestHead, status, groups) {
    const head = Buffer.alloc(8);
    head.writeUInt8(requestHead.readUInt8(0), 0);
    head.writeUInt8(requestHead.readUInt8(1), 1);
    head.writeUInt16BE(status, 2);
    requestHead.copy(head, 4, 4, 8);
    return Buffer.concat([head, Buffer.from([0x01]), ipp.attr(T.charset, 'attributes-charset', 'utf-8'), ipp.attr(T.language, 'attributes-natural-language', 'en'), ...groups, Buffer.from([0x03])]);
  }

  /** The operation attributes of a request: name -> first value (strings, ints), and where the data starts. */
  function parseRequest(buf) {
    const attrs = {};
    let i = 8;
    let last = '';
    while (i < buf.length) {
      const tag = buf[i++];
      if (tag === 0x03) break;
      if (tag <= 0x0f) continue;
      const nl = buf.readUInt16BE(i);
      i += 2;
      const name = buf.toString('utf8', i, i + nl) || last;
      i += nl;
      const vl = buf.readUInt16BE(i);
      i += 2;
      const v = buf.subarray(i, i + vl);
      i += vl;
      last = name;
      if (!(name in attrs)) attrs[name] = tag === T.integer || tag === T.enum ? v.readInt32BE(0) : v.toString('utf8');
    }
    return { op: buf.readUInt16BE(2), attrs, data: buf.subarray(i) };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method !== 'POST' || body.length < 9) {
        res.statusCode = 400;
        return res.end();
      }
      const { op, attrs, data } = parseRequest(body);
      let out;
      if (op === OP.GetPrinter) out = respond(body, 0, [Buffer.from([0x04]), ...printerAttrs(req.headers.host)]);
      else if (op === OP.Validate) out = respond(body, 0, []);
      else if (op === OP.Print) {
        const job = { id: jobs.length + 1, state: 9, bytes: data.length, format: attrs['document-format'], name: attrs['job-name'], copies: attrs.copies, data };
        jobs.push(job);
        out = respond(body, 0, [jobGroup(job)]);
      } else if (op === OP.GetJob) {
        const job = jobs.find((j) => j.id === attrs['job-id']);
        out = job ? respond(body, 0, [jobGroup(job)]) : respond(body, 0x0406, []);
      } else if (op === OP.GetJobs) out = respond(body, 0, jobs.map(jobGroup));
      else if (op === OP.Cancel) out = respond(body, 0, []);
      else out = respond(body, 0x0501, []);
      res.setHeader('Content-Type', 'application/ipp');
      res.end(out);
    });
  });

  return {
    jobs,
    uri,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        boundPort = server.address().port;
        resolve({ port: boundPort });
      });
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
    setState: (s) => (state = s),
  };
}

module.exports = { createFakeIppPrinter };
