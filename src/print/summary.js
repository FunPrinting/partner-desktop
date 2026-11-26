'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');
const { SIZES } = require('./pdf');

const WEB_URL = process.env.FP_WEB_URL || 'https://www.funprinting.store';

const latin1 = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const colourText = { bw: 'Black & White', color: 'Colour', mixed: 'Mixed Colour' };

function fileLine(f, i) {
  const colour = f.color === 'mixed' && f.colorPages?.length ? `Colour pages ${compactPages(f.colorPages)}` : colourText[f.color] || 'Black & White';
  const sided = f.sided === 'double' ? 'Double-sided' : 'Single-sided';
  const copies = f.copies || 1;
  return `${i + 1}. ${f.name || `File ${i + 1}`}  |  ${f.pages ?? '?'} page(s)  |  ${f.pageSize || 'A4'}  |  ${sided}  |  ${colour}  |  ${copies} cop${copies === 1 ? 'y' : 'ies'}`;
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
 * Renders the full, traditional Order Summary page (cover sheet) with complete
 * order details, file breakdown, customer information, delivery/pickup details,
 * and a verification QR code.
 *
 * @param {object} job       the server job { orderId, deliveryNumber, deliveryType, files, service, createdAt, ... }
 * @param {object} [order]   order details { customerInfo, amount, expectedDate, deliveryOption, ... }
 * @returns {Promise<Buffer>} a one-page A4 PDF buffer
 */
async function renderSummary(job, order = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Order Summary ${job.orderId}`);
  const [W, H] = SIZES.A4;
  const page = doc.addPage([W, H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const M = 48;
  const ink = rgb(0, 0, 0);
  const blue = rgb(0.1, 0.1, 0.5);
  const grey = rgb(0.35, 0.35, 0.35);
  let y = H - M;

  const text = (s, { size = 11, font = regular, color = ink, x = M } = {}) => {
    page.drawText(latin1(s), { x, y, size, font, color });
  };

  const drawDivider = () => {
    y -= 12;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: ink });
    y -= 18;
  };

  // Merge order and job fields
  const c = order.customerInfo || job.customerInfo || {};
  const d = order.deliveryOption || job.deliveryOption || {};
  const amt = order.amount ?? job.amount ?? order.pricing?.totalPrice;
  const due = order.expectedDate || job.expectedDate;
  const services = (job.service && job.service.length ? job.service : order.printingOptions?.serviceOptions) || [];

  // ============ 1. HEADER WITH QR CODE ============
  const qrSize = 100;
  const qrX = W - M - qrSize;
  const qrY = H - M - qrSize + 10;

  try {
    const qr = QRCode.create(`${WEB_URL}/orders/${encodeURIComponent(job.orderId)}`, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const cell = qrSize / count;
    for (let r = 0; r < count; r++) {
      for (let col = 0; col < count; col++) {
        if (qr.modules.get(r, col)) {
          page.drawRectangle({
            x: qrX + col * cell,
            y: qrY + (count - 1 - r) * cell,
            width: cell,
            height: cell,
            color: ink,
          });
        }
      }
    }
    const scanLabel = 'Scan to verify order';
    const labelW = regular.widthOfTextAtSize(scanLabel, 8);
    page.drawText(scanLabel, { x: qrX + (qrSize - labelW) / 2, y: qrY - 12, size: 8, font: regular, color: grey });
  } catch (err) {
    console.error('Failed to generate QR code on summary:', err);
  }

  // Left header
  text('Order Summary', { size: 24, font: bold });
  y -= 26;
  text(`Order ID: ${job.orderId}`, { size: 13, font: bold, color: blue });
  y -= 18;
  if (job.deliveryNumber) {
    text(`Delivery Tag: #${job.deliveryNumber}`, { size: 12, font: bold, color: ink });
    y -= 16;
  }
  const placed = job.createdAt ? new Date(job.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  text(`Order Time: ${placed}`, { size: 10, color: grey });

  // Move below header and QR
  y = Math.min(y, qrY - 25);
  drawDivider();

  // ============ 2. ORDER DETAILS ============
  text('Order Details', { size: 14, font: bold });
  y -= 20;

  const totalFiles = (job.files || []).length;
  const totalPages = (job.files || []).reduce((acc, f) => acc + (f.pages || 1) * (f.copies || 1), 0);
  const totalCopies = (job.files || []).reduce((acc, f) => acc + (f.copies || 1), 0);

  text(`Files Count: ${totalFiles}  |  Total Pages: ${totalPages}  |  Total Copies: ${totalCopies}`, { size: 11, font: bold });
  y -= 18;

  // File breakdown list
  text('Files Breakdown:', { size: 11, font: bold, color: grey });
  y -= 4;
  for (const [i, f] of (job.files || []).entries()) {
    for (const line of wrap(fileLine(f, i), regular, 10, W - 2 * M)) {
      y -= 15;
      if (y < M + 140) break;
      text(line, { size: 10 });
    }
  }

  // Service Options / Finishing
  y -= 16;
  if (services.length > 0) {
    text(`Service Options: ${services.join(', ')}`, { size: 11, font: bold });
  } else {
    text('Service Options: None', { size: 11, color: grey });
  }
  y -= 16;

  // Total Amount
  if (amt !== undefined) {
    text(`Total Amount: Rs ${amt} (Paid)`, { size: 12, font: bold });
    y -= 16;
  }

  // Expected Delivery / Scheduled Pickup Slot
  if (d.scheduledSlot?.date) {
    const slotDateStr = new Date(`${d.scheduledSlot.date}T00:00:00Z`).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });
    const slotTime = d.scheduledSlot.label ? String(d.scheduledSlot.label).replace(/\u2013/g, '-') : '';
    text(`Scheduled Pickup: ${slotDateStr}${slotTime ? ` | ${slotTime}` : ''}`, { size: 11, font: bold });
    y -= 16;
  } else if (due) {
    const dueStr = new Date(due).toLocaleDateString('en-IN', { dateStyle: 'medium' });
    text(`Expected Delivery: ${dueStr}`, { size: 11 });
    y -= 16;
  }

  // Fulfilment / Pickup Details
  if (d.partnerDeliveryPoint) {
    text(`Pickup Point: ${d.partnerDeliveryPoint}`, { size: 11, font: bold });
    y -= 16;
  } else if (d.type === 'delivery' || job.deliveryType === 'delivery') {
    const recipient = [d.recipientName, d.recipientPhone].filter(Boolean).join(' · ');
    const address = [d.flatBuilding, d.address, d.city, d.pinCode].filter(Boolean).join(', ');
    text(`Deliver To: ${recipient || 'Customer Address'}`, { size: 11, font: bold });
    y -= 15;
    if (address) {
      text(`Address: ${address}`, { size: 10 });
      y -= 15;
    }
  } else {
    text('Fulfilment: In-Store Pickup (Free)', { size: 11, color: grey });
    y -= 16;
  }

  drawDivider();

  // ============ 3. CUSTOMER INFORMATION ============
  text('Customer Information', { size: 14, font: bold });
  y -= 20;

  text(`Name: ${c.name || 'Not provided'}`, { size: 11, font: c.name ? bold : regular });
  y -= 16;
  text(`Phone: ${c.phone || 'Not provided'}`, { size: 11 });
  y -= 16;
  text(`Email: ${c.email || 'Not provided'}`, { size: 11 });

  // Footer branding
  y = M;
  text('FunPrinting Partner · Print Station', { size: 9, color: grey });

  return Buffer.from(await doc.save());
}

module.exports = { renderSummary, compactPages };
