"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateFileNumberPage = generateFileNumberPage;
exports.generateLetterSeparator = generateLetterSeparator;
exports.saveTempFile = saveTempFile;
exports.cleanupTempFile = cleanupTempFile;
exports.generateOrderSummaryPage = generateOrderSummaryPage;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const pdf_lib_1 = require("pdf-lib");
const qrcode_1 = __importDefault(require("qrcode"));
/**
 * Generate a file number page PDF for separator printing
 * @param fileNumber - File number (1-10)
 */
async function generateFileNumberPage(fileNumber) {
    // Create a PDF with "File no: X" centered on the page
    const fileNumberText = `File no: ${fileNumber}`;
    const pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Resources <<
/Font <<
/F1 <<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Bold
>>
>>
>>
/Contents 4 0 R
>>
endobj
4 0 obj
<<
/Length 120
>>
stream
BT
/F1 24 Tf
200 400 Td
(${fileNumberText}) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000306 00000 n 
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
446
%%EOF`;
    return Buffer.from(pdfContent);
}
/**
 * Generate a letter separator page PDF
 * @param letter - Letter to print (A-Z)
 */
async function generateLetterSeparator(letter) {
    // Create a PDF with a large letter centered on the page
    const pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Resources <<
/Font <<
/F1 <<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Bold
>>
>>
>>
/Contents 4 0 R
>>
endobj
4 0 obj
<<
/Length 100
>>
stream
BT
/F1 120 Tf
200 400 Td
(${letter}) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000306 00000 n 
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
446
%%EOF`;
    return Buffer.from(pdfContent);
}
/**
 * Save file to temporary directory
 */
function saveTempFile(data, filename) {
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, data);
    return filePath;
}
/**
 * Clean up temporary file
 */
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
    catch (error) {
        console.error(`Error cleaning up temp file ${filePath}:`, error);
    }
}
/**
 * Generate order summary page PDF with QR code, Order ID, and Order Time
 * @param orderDetails - Order details object
 * @param customerInfo - Customer information object
 * @param orderId - The order ID (e.g., ORD123456789)
 * @param orderTime - The order creation time (ISO string or Date)
 */
async function generateOrderSummaryPage(orderDetails, customerInfo, orderId, orderTime) {
    const pdfDoc = await pdf_lib_1.PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]); // A4 size
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    let yPosition = height - 60;
    const lineHeight = 20;
    const sectionSpacing = 25;
    const leftMargin = 50;
    // ============ QR CODE SECTION (top-right) ============
    const qrSize = 120;
    const qrX = width - leftMargin - qrSize;
    const qrY = height - 60 - qrSize;
    if (orderId) {
        try {
            // Build verification URL
            const baseUrl = process.env.FUNPRINTING_URL || 'https://www.funprinting.store';
            const verifyUrl = `${baseUrl}/verify-order/${orderId}`;
            // Generate QR code as PNG buffer
            const qrPngBuffer = await qrcode_1.default.toBuffer(verifyUrl, {
                width: qrSize * 2, // Higher resolution for crisp printing
                margin: 1,
                errorCorrectionLevel: 'H',
                color: {
                    dark: '#000000',
                    light: '#ffffff',
                },
            });
            // Embed QR code image in PDF
            const qrImage = await pdfDoc.embedPng(qrPngBuffer);
            page.drawImage(qrImage, {
                x: qrX,
                y: qrY,
                width: qrSize,
                height: qrSize,
            });
            // Label below QR code
            const scanText = 'Scan to verify order';
            const scanTextWidth = font.widthOfTextAtSize(scanText, 8);
            page.drawText(scanText, {
                x: qrX + (qrSize - scanTextWidth) / 2,
                y: qrY - 12,
                size: 8,
                font: font,
                color: (0, pdf_lib_1.rgb)(0.4, 0.4, 0.4),
            });
        }
        catch (qrError) {
            console.error('Failed to generate QR code for order summary:', qrError);
            // Continue without QR code
        }
    }
    // ============ TITLE ============
    page.drawText('Order Summary', {
        x: leftMargin,
        y: yPosition,
        size: 24,
        font: fontBold,
        color: (0, pdf_lib_1.rgb)(0, 0, 0),
    });
    yPosition -= 30;
    // ============ ORDER ID & TIME ============
    if (orderId) {
        page.drawText(`Order ID: ${orderId}`, {
            x: leftMargin,
            y: yPosition,
            size: 14,
            font: fontBold,
            color: (0, pdf_lib_1.rgb)(0.1, 0.1, 0.5),
        });
        yPosition -= lineHeight;
    }
    if (orderTime) {
        const timeStr = typeof orderTime === 'string'
            ? new Date(orderTime).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
            : orderTime.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        page.drawText(`Order Time: ${timeStr}`, {
            x: leftMargin,
            y: yPosition,
            size: 11,
            font: font,
            color: (0, pdf_lib_1.rgb)(0.3, 0.3, 0.3),
        });
        yPosition -= lineHeight;
    }
    yPosition -= 10;
    // Draw line
    page.drawLine({
        start: { x: leftMargin, y: yPosition },
        end: { x: width - leftMargin, y: yPosition },
        thickness: 1,
        color: (0, pdf_lib_1.rgb)(0, 0, 0),
    });
    yPosition -= sectionSpacing;
    // ============ ORDER DETAILS ============
    const formatColor = (color) => {
        if (color === 'bw')
            return 'Black & White';
        if (color === 'color')
            return 'Color';
        if (color === 'mixed')
            return 'Mixed';
        return color;
    };
    const formatSided = (sided) => {
        if (sided === 'single')
            return 'Single-sided';
        if (sided === 'double')
            return 'Double-sided';
        return sided;
    };
    const formatOrderType = (orderType) => {
        if (orderType === 'file')
            return 'File Upload';
        if (orderType === 'template')
            return 'Template';
        return orderType;
    };
    const orderSummaryLines = [
        `Order Type: ${formatOrderType(orderDetails.orderType)}`,
        `Page Size: ${orderDetails.pageSize}`,
        `Color: ${formatColor(orderDetails.color)}`,
        `Sided: ${formatSided(orderDetails.sided)}`,
        `Copies: ${orderDetails.copies}`,
        `Pages: ${orderDetails.pages}`,
    ];
    // Add Service Options
    if (orderDetails.serviceOptions && orderDetails.serviceOptions.length > 0) {
        orderSummaryLines.push('Service Options:');
        orderDetails.serviceOptions.forEach((serviceOption) => {
            const optionsText = serviceOption.options.length > 0
                ? serviceOption.options.join(', ')
                : 'None';
            orderSummaryLines.push(`  ${serviceOption.fileName}: ${optionsText}`);
        });
    }
    // Add Total Amount (use "Rs" instead of ₹ symbol to avoid encoding issues with standard fonts)
    orderSummaryLines.push(`Total Amount: Rs ${orderDetails.totalAmount}`);
    // Add Expected Delivery
    if (orderDetails.expectedDelivery) {
        orderSummaryLines.push(`Expected Delivery: ${orderDetails.expectedDelivery}`);
    }
    // Draw order summary lines
    orderSummaryLines.forEach((line) => {
        if (yPosition < 100) {
            // If we run out of space, we could add a new page, but for now just stop
            return;
        }
        page.drawText(line, {
            x: leftMargin,
            y: yPosition,
            size: 12,
            font: line.startsWith('Service Options:') || line.startsWith('  ') ? font : fontBold,
            color: (0, pdf_lib_1.rgb)(0, 0, 0),
        });
        yPosition -= lineHeight;
    });
    yPosition -= sectionSpacing;
    // ============ CUSTOMER INFORMATION ============
    page.drawText('Customer Information', {
        x: leftMargin,
        y: yPosition,
        size: 18,
        font: fontBold,
        color: (0, pdf_lib_1.rgb)(0, 0, 0),
    });
    yPosition -= 30;
    // Draw line
    page.drawLine({
        start: { x: leftMargin, y: yPosition },
        end: { x: width - leftMargin, y: yPosition },
        thickness: 1,
        color: (0, pdf_lib_1.rgb)(0, 0, 0),
    });
    yPosition -= sectionSpacing;
    // Customer details
    const customerLines = [
        `Name: ${customerInfo.name}`,
        `Phone: ${customerInfo.phone}`,
        `Email: ${customerInfo.email}`,
    ];
    customerLines.forEach((line) => {
        if (yPosition < 50) {
            return;
        }
        page.drawText(line, {
            x: leftMargin,
            y: yPosition,
            size: 12,
            font: font,
            color: (0, pdf_lib_1.rgb)(0, 0, 0),
        });
        yPosition -= lineHeight;
    });
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}
