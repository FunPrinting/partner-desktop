const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { printPdfWithChrome } = require("./chromePrint");

async function printPdfWithMixedColorInSequence(pdfPath, colorPages, bwPages, printerName, copies, pageSize, sided, tempDir) {
  try {
    console.log(`🔍 DEBUG - printPdfWithMixedColorInSequence called:`);
    console.log(`   PDF: ${pdfPath}`);
    console.log(`   Color pages (1-based): [${colorPages.join(', ')}]`);
    console.log(`   B&W pages (1-based): [${bwPages.join(', ')}]`);
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await pdf_lib_1.PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    console.log(`   Total pages in PDF: ${totalPages}`);
    // Convert 1-based page numbers to 0-based indices
    const colorIndices = new Set(colorPages.map(p => p - 1).filter(i => i >= 0 && i < totalPages));
    const bwIndices = new Set(bwPages.map(p => p - 1).filter(i => i >= 0 && i < totalPages));
    console.log(`   Color indices (0-based): [${Array.from(colorIndices).join(', ')}]`);
    console.log(`   B&W indices (0-based): [${Array.from(bwIndices).join(', ')}]`);
    // Determine page color mode for each page
    // Priority: colorIndices > bwIndices > default (B&W)
    const pageColorMode = new Map();
    for (let i = 0; i < totalPages; i++) {
      if (colorIndices.has(i)) {
        pageColorMode.set(i, false); // false = color
      }
      else if (bwIndices.has(i)) {
        pageColorMode.set(i, true); // true = monochrome (B&W)
      }
      else {
        // Default to B&W if not specified in either array
        pageColorMode.set(i, true); // true = monochrome (B&W)
      }
    }
    // Group consecutive pages with the same color mode to minimize print jobs
    const pageGroups = [];
    let currentGroup = null;
    for (let i = 0; i < totalPages; i++) {
      // Fix: Use non-null assertion since all pages are guaranteed to be in the map
      const isMonochrome = pageColorMode.get(i);
      if (currentGroup === null) {
        // Start new group
        currentGroup = { startIndex: i, endIndex: i, isMonochrome };
      }
      else if (currentGroup.isMonochrome === isMonochrome) {
        // Extend current group
        currentGroup.endIndex = i;
      }
      else {
        // Save current group and start new one
        pageGroups.push(currentGroup);
        currentGroup = { startIndex: i, endIndex: i, isMonochrome };
      }
    }
    // Add last group
    if (currentGroup !== null) {
      pageGroups.push(currentGroup);
    }
    console.log(`📋 Printing ${totalPages} pages in ${pageGroups.length} groups to maintain sequence`);
    console.log(`📋 Page groups created:`);
    pageGroups.forEach((group, idx) => {
      console.log(`   Group ${idx + 1}: Pages ${group.startIndex + 1}-${group.endIndex + 1} (${group.isMonochrome ? 'B&W' : 'Color'})`);
    });
    // Reverse the groups array to print in reverse order (stack-based printing)
    // Last group prints first, so pages stack correctly (last printed = top of stack)
    pageGroups.reverse();
    console.log(`🔄 Printing in reverse order (stack-based) to maintain correct page sequence`);
    // Print each group in reverse order (last group first)
    for (let groupIndex = 0; groupIndex < pageGroups.length; groupIndex++) {
      const group = pageGroups[groupIndex];
      const pageCount = group.endIndex - group.startIndex + 1;
      // Create PDF for this group
      const groupPdf = await pdf_lib_1.PDFDocument.create();
      for (let i = group.startIndex; i <= group.endIndex; i++) {
        const [copiedPage] = await groupPdf.copyPages(pdfDoc, [i]);
        groupPdf.addPage(copiedPage);
      }
      const groupPdfBytes = await groupPdf.save();
      const groupPdfPath = path.join(tempDir, `group_${groupIndex}_${group.isMonochrome ? 'bw' : 'color'}_${Date.now()}.pdf`);
      fs.writeFileSync(groupPdfPath, groupPdfBytes);
      // Calculate actual group number in original order (before reverse)
      const originalGroupNum = pageGroups.length - groupIndex;
      console.log(`🖨️ Printing Group ${originalGroupNum} (reverse order ${groupIndex + 1}/${pageGroups.length}): Pages ${group.startIndex + 1}-${group.endIndex + 1} (${group.isMonochrome ? 'B&W' : 'Color'})...`);
      // For B&W groups, force printer driver to grayscale mode for fast printing
      // For Color groups, force printer driver to color mode
      if (process.platform === 'win32') {
        if (group.isMonochrome) {
          await forceGrayscaleMode(printerName);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        else {
          await forceColorMode(printerName);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      // Print with Chrome (primary), SumatraPDF (fallback), or Windows print spooler (last resort)
      try {
        // Pass groupIndex for unique port calculation
        await printPdfWithChrome(groupPdfPath, printerName, group.isMonochrome, copies, groupIndex);
      }
      catch (error) {
        console.warn(`⚠️ Chrome failed for group, trying SumatraPDF: ${error.message}`);
        try {
          await printPdfWithSumatra(groupPdfPath, printerName, group.isMonochrome, copies);
        }
        catch (sumatraError) {
          console.warn(`⚠️ SumatraPDF failed for group, trying Windows spooler: ${sumatraError.message}`);
          await printPdfWithWindowsSpooler(groupPdfPath, printerName, group.isMonochrome, copies);
        }
      }
      console.log(`✅ Group ${originalGroupNum} printed successfully: Pages ${group.startIndex + 1}-${group.endIndex + 1} (${group.isMonochrome ? 'B&W' : 'Color'})`);
      // Cleanup: Delete file AFTER printing is complete and HTTP server has closed
      // The printPdfWithChrome function ensures the HTTP server closes before returning
      if (fs.existsSync(groupPdfPath)) {
        fs.unlinkSync(groupPdfPath);
        console.log(`🗑️ Cleaned up group PDF: ${groupPdfPath}`);
      }
      // Small delay between groups to ensure proper sequencing
      if (groupIndex < pageGroups.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    console.log(`✅ All ${totalPages} pages printed in correct sequence (stack-based reverse order)`);
    console.log(`📄 Final page order in output: Page 1 (top) → Page ${totalPages} (bottom)`);
  }
  catch (error) {
    console.error(`❌ Error printing PDF with mixed color in sequence: ${error.message}`);
    throw new Error(`Failed to print PDF with mixed color in sequence: ${error.message}`);
  }
}

module.exports = { printPdfWithMixedColorInSequence };
