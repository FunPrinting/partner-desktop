'use strict';
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

/**
 * An A4 page that shows a shop owner whether the printer works: printer name, time,
 * a frame that reveals clipped margins, a grey ramp and colour swatches.
 */
async function renderTestPage({ printerName, colour, at = new Date() }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 18, y: 18, width: width - 36, height: height - 36, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawText('FunPrinting test page', { x: 50, y: height - 90, size: 28, font: bold });
  page.drawText(`Printer: ${printerName}`.slice(0, 80), { x: 50, y: height - 125, size: 13, font });
  page.drawText(at.toLocaleString('en-IN'), { x: 50, y: height - 145, size: 11, font, color: rgb(0.35, 0.35, 0.35) });
  page.drawText('If you can read this and the frame is complete on all four sides, this printer is ready for orders.', { x: 50, y: height - 185, size: 10, font, maxWidth: width - 100 });
  // Grey ramp
  for (let i = 0; i < 11; i++) {
    const g = i / 10;
    page.drawRectangle({ x: 50 + i * 45, y: height - 270, width: 45, height: 50, color: rgb(g, g, g) });
  }
  page.drawText('Greys', { x: 50, y: height - 285, size: 9, font });
  // Colour swatches (a colour page on a B&W printer simply prints them grey)
  const swatches = [rgb(0.9, 0.1, 0.1), rgb(0.1, 0.7, 0.2), rgb(0.1, 0.3, 0.9), rgb(0.1, 0.8, 0.85), rgb(0.9, 0.2, 0.7), rgb(0.98, 0.85, 0.1)];
  swatches.forEach((c, i) => page.drawRectangle({ x: 50 + i * 75, y: height - 360, width: 75, height: 60, color: c }));
  page.drawText(colour ? 'Colours' : 'Colours (this printer prints black and white)', { x: 50, y: height - 375, size: 9, font });
  // Fine text
  const sizes = [6, 8, 10, 12, 16];
  sizes.forEach((s, i) => page.drawText(`The quick brown fox jumps over the lazy dog (${s} pt)`, { x: 50, y: height - 420 - i * 24, size: s, font }));
  return Buffer.from(await doc.save());
}

module.exports = { renderTestPage };
