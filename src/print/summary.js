'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');
const { SIZES } = require('./pdf');

/**
 * The order cover sheet: one A4 page printed in B&W before the order's first file, so the
 * shop can tell orders apart in the output tray and match them to customers.
 *
 * Shows the delivery number large (what staff sort by), the order, customer, each file's
 * print settings, and a QR code to the order page.
 *
 * Standard PDF fonts only cover Latin-1, so other characters (for example Hindi names) are
 * replaced rather than breaking the page.
 */
const WEB_URL = process.env.FP_WEB_URL || 'https://www.funprinting.store';

const latin1 = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const colourText = { bw: 'B&W', color: 'Colour', mixed: 'Mixed colour' };

function fileLine(f, i) {
  const colour = f.color === 'mixed' && f.colorPages?.length ? `Colour pages ${compactPages(f.colorPages)}` : colourText[f.color] || 'B&W';
  return `${i + 1}. ${f.name || `File ${i + 1}`}  |  ${f.pages ?? '?'} pages  |  ${f.pageSize || 'A4'}  |  ${f.sided === 'double' ? 'Double-sided' : 'Single-sided'}  |  ${colour}  |  ${f.copies || 1} cop${(f.copies || 1) === 1 ? 'y' : 'ies'}`;
}

/** [1,2,3,7,9,10] -> "1-3, 7, 9-10" */
function compactPages(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(', ');
}

/** Breaks text into lines that fit `width` points. */
function wrap(text, font, size, width) {
  const words = latin1(text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * @param {object} job       the server job { orderId, deliveryNumber, deliveryType, files, service, createdAt }
 * @param {object} [order]   from /api/partner/orders/:id { customerInfo, amount, expectedDate }
 * @returns {Promise<Buffer>} a one-page A4 PDF
 */
async function renderSummary(job, order = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Order ${job.orderId}`);
  const [W, H] = SIZES.A4;
  const page = doc.addPage([W, H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const M = 48;
  const ink = rgb(0, 0, 0);
  const grey = rgb(0.35, 0.35, 0.35);
  let y = H - M;

  const text = (s, { size = 11, font = regular, color = ink, x = M } = {}) => {
    page.drawText(latin1(s), { x, y, size, font, color });
  };

  // QR code to the order page (top right)
  const qrSize = 96;
  try {
    const png = await QRCode.toBuffer(`${WEB_URL}/orders/${encodeURIComponent(job.orderId)}`, { width: qrSize * 3, margin: 0, errorCorrectionLevel: 'M' });
    page.drawImage(await doc.embedPng(png), { x: W - M - qrSize, y: H - M - qrSize, width: qrSize, height: qrSize });
  } catch {
    // the sheet is still useful without the code
  }

  // Delivery number: the largest thing on the page
  y -= 40;
  text(job.deliveryNumber || job.orderId, { size: 40, font: bold });
  y -= 22;
  text(`Order ${job.orderId}`, { size: 13, font: bold });
  y -= 16;
  const placed = job.createdAt ? new Date(job.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  text([placed, job.deliveryType === 'delivery' ? 'Delivery' : 'Pickup'].filter(Boolean).join('  |  '), { color: grey });

  y = Math.min(y, H - M - qrSize) - 28;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: ink });

  const c = order.customerInfo || {};
  if (c.name || c.phone) {
    y -= 26;
    text('Customer', { size: 10, color: grey });
    y -= 18;
    text(c.name || '', { size: 16, font: bold });
    y -= 18;
    text([c.phone, c.email].filter(Boolean).join('  |  '));
  }

  y -= 30;
  text(`Files (${job.files.length})`, { size: 10, color: grey });
  y -= 6;
  for (const [i, f] of job.files.entries()) {
    for (const line of wrap(fileLine(f, i), regular, 10.5, W - 2 * M)) {
      y -= 15;
      if (y < M + 60) break;
      text(line, { size: 10.5 });
    }
    y -= 4;
  }

  if (job.service?.length) {
    y -= 18;
    text(`Finishing: ${job.service.join(', ')}`, { size: 11, font: bold });
  }

  const footer = [order.amount !== undefined ? `Amount: Rs ${order.amount}` : null, order.expectedDate ? `Due: ${new Date(order.expectedDate).toLocaleDateString('en-IN')}` : null]
    .filter(Boolean)
    .join('  |  ');
  if (footer) {
    y = M + 10;
    text(footer, { size: 11 });
  }

  return Buffer.from(await doc.save());
}

module.exports = { renderSummary, compactPages };
