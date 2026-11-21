'use strict';

const http = require('node:http');

/**
 * Minimal IPP/1.1 client (RFC 8010/8011) for the local CUPS server: printer state and
 * capabilities (Get-Printer-Attributes) and job state (Get-Job-Attributes). CUPS answers
 * these for every queue, driver-based or driverless, from the PPD or the printer.
 * Same encoding as partner-mobile/src/lib/ipp.ts.
 */

const Op = { CancelJob: 0x0008, GetJobAttributes: 0x0009, GetPrinterAttributes: 0x000b, GetPrinters: 0x4002 };
const Tag = { integer: 0x21, boolean: 0x22, enum: 0x23, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48, name: 0x42, text: 0x41, mime: 0x49 };
const GROUP = { 1: 'operation', 2: 'job', 4: 'printer', 5: 'unsupported' };

const JOB_STATE = { 3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' };
const PRINTER_STATE = { 3: 'idle', 4: 'processing', 5: 'stopped' };

function attr(tag, name, values) {
  const parts = [];
  (Array.isArray(values) ? values : [values]).forEach((v, i) => {
    const n = i === 0 ? Buffer.from(name) : Buffer.alloc(0);
    let val;
    if (tag === Tag.integer || tag === Tag.enum) {
      val = Buffer.alloc(4);
      val.writeInt32BE(Number(v));
    } else if (tag === Tag.boolean) val = Buffer.from([v ? 1 : 0]);
    else val = Buffer.from(String(v));
    const head = Buffer.alloc(3);
    head.writeUInt8(tag, 0);
    head.writeUInt16BE(n.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(val.length);
    parts.push(head, n, len, val);
  });
  return Buffer.concat(parts);
}

function encode(operation, requestId, operationAttrs) {
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt8(1, 1);
  head.writeUInt16BE(operation, 2);
  head.writeUInt32BE(requestId, 4);
  return Buffer.concat([
    head,
    Buffer.from([0x01]),
    attr(Tag.charset, 'attributes-charset', 'utf-8'),
    attr(Tag.language, 'attributes-natural-language', 'en'),
    ...operationAttrs,
    Buffer.from([0x03]),
  ]);
}

/** Decodes a response into { statusCode, groups: [{ name, attrs }] } (one entry per group). */
function decode(buf) {
  if (buf.length < 9) throw new Error('IPP response too short');
  const out = { version: `${buf[0]}.${buf[1]}`, statusCode: buf.readUInt16BE(2), requestId: buf.readUInt32BE(4), groups: [] };
  let i = 8;
  let group = null;
  let last = '';
  while (i < buf.length) {
    const tag = buf[i++];
    if (tag === 0x03) break;
    if (tag <= 0x0f) {
      group = { name: GROUP[tag] || `group-${tag}`, attrs: {} };
      out.groups.push(group);
      continue;
    }
    if (i + 4 > buf.length) break;
    const nameLen = buf.readUInt16BE(i);
    i += 2;
    const name = buf.toString('utf8', i, i + nameLen);
    i += nameLen;
    const valueLen = buf.readUInt16BE(i);
    i += 2;
    const raw = buf.subarray(i, i + valueLen);
    i += valueLen;
    if (!group) continue;
    let value;
    if ((tag === Tag.integer || tag === Tag.enum) && valueLen === 4) value = raw.readInt32BE(0);
    else if (tag === Tag.boolean && valueLen === 1) value = raw[0] === 1;
    else if (tag >= 0x40 && tag <= 0x4a) value = raw.toString('utf8');
    else if (tag === 0x13 || tag === 0x12 || tag === 0x10) value = null; // no-value, unknown, unsupported
    else value = undefined; // dates, ranges, resolutions, collections: not needed
    if (nameLen > 0) {
      last = name;
      group.attrs[name] = value === undefined ? [] : [value];
    } else if (last && value !== undefined) group.attrs[last].push(value);
  }
  return out;
}

const ok = (code) => code >= 0 && code <= 0xff;

/**
 * Sends one request to the local CUPS server. `socketPath` is used when CUPS doesn't
 * listen on TCP (some Linux setups); otherwise localhost:631.
 */
function request(body, { path = '/', host = 'localhost', port = 631, socketPath, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'POST', host, port, socketPath, path, headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(Object.assign(new Error(`CUPS answered HTTP ${res.statusCode}`), { http: res.statusCode }));
          try {
            resolve(decode(Buffer.concat(chunks)));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('CUPS did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

let seq = 0;
const nextId = () => (seq = (seq % 0x7fffffff) + 1);
const printerUri = (name) => `ipp://localhost/printers/${encodeURIComponent(name)}`;

const PRINTER_ATTRS = [
  'printer-name',
  'printer-info',
  'printer-make-and-model',
  'printer-location',
  'device-uri',
  'printer-uuid',
  'printer-type',
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-is-accepting-jobs',
  'color-supported',
  'sides-supported',
  'print-color-mode-supported',
  'media-supported',
  'document-format-supported',
];

async function getPrinterAttributes(name, opts) {
  const res = await request(
    encode(Op.GetPrinterAttributes, nextId(), [attr(Tag.uri, 'printer-uri', printerUri(name)), attr(Tag.keyword, 'requested-attributes', PRINTER_ATTRS)]),
    { ...opts, path: `/printers/${encodeURIComponent(name)}` }
  );
  if (!ok(res.statusCode)) throw Object.assign(new Error(`CUPS: printer ${name} status 0x${res.statusCode.toString(16)}`), { ipp: res.statusCode });
  return res.groups.find((g) => g.name === 'printer')?.attrs || {};
}

/** All queues (CUPS-Get-Printers), each as its attribute map. */
async function getPrinters(opts) {
  const res = await request(encode(Op.GetPrinters, nextId(), [attr(Tag.keyword, 'requested-attributes', PRINTER_ATTRS)]), { ...opts, path: '/' });
  if (!ok(res.statusCode) && res.statusCode !== 0x0406) throw Object.assign(new Error(`CUPS: list printers status 0x${res.statusCode.toString(16)}`), { ipp: res.statusCode });
  return res.groups.filter((g) => g.name === 'printer').map((g) => g.attrs);
}

async function getJobAttributes(name, jobId, opts) {
  const res = await request(
    encode(Op.GetJobAttributes, nextId(), [
      attr(Tag.uri, 'printer-uri', printerUri(name)),
      attr(Tag.integer, 'job-id', jobId),
      attr(Tag.keyword, 'requested-attributes', ['job-state', 'job-state-reasons', 'job-printer-state-message']),
    ]),
    { ...opts, path: '/jobs/' }
  );
  if (res.statusCode === 0x0406) return null; // not found
  if (!ok(res.statusCode)) throw Object.assign(new Error(`CUPS: job ${jobId} status 0x${res.statusCode.toString(16)}`), { ipp: res.statusCode });
  return res.groups.find((g) => g.name === 'job')?.attrs || {};
}

async function cancelJob(name, jobId, opts) {
  const res = await request(
    encode(Op.CancelJob, nextId(), [attr(Tag.uri, 'printer-uri', printerUri(name)), attr(Tag.integer, 'job-id', jobId), attr(Tag.name, 'requesting-user-name', require('node:os').userInfo().username)]),
    { ...opts, path: '/jobs/' }
  );
  return ok(res.statusCode) || res.statusCode === 0x0406;
}

module.exports = { Op, Tag, JOB_STATE, PRINTER_STATE, attr, encode, decode, request, getPrinterAttributes, getPrinters, getJobAttributes, cancelJob };
