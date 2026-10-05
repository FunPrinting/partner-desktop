"use strict";

const fs = require("fs");
const path = require("path");
const { downloadFile } = require("./utils/fileUtils");
const { printFile } = require("./printFile");
const { generateOrderSummaryPage } = require("../../printerUtils");

/**
 * Emit print status to renderer via BrowserWindow IPC
 */
function emitStatus(jobId, status) {
  try {
    const { BrowserWindow } = require("electron");
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      wins[0].webContents.send("print_status", {
        jobId,
        status,
        packetSize: 5,
      });
    }
  } catch {
    // Ignore — may not be running in Electron context
  }
}

/**
 * Main print job handler
 * Downloads the document, prints it, and optionally prints an order summary page.
 */
async function printJob(job, printerIndex) {
  try {
    // Normalize properties for backwards compatibility
    const defaultExt = job.fileType
      ? job.fileType.startsWith(".")
        ? job.fileType
        : `.${job.fileType}`
      : ".pdf";
    job.fileName =
      job.fileName || job.originalFileName || `document${defaultExt}`;
    job.fileUrl = job.fileUrl || job.documentUrl || job.url;

    if (!job.fileUrl) {
      throw new Error("No document URL provided in job");
    }

    emitStatus(job.id || job.orderId, "Downloading document...");
    console.log(
      `Starting print job: ${job.fileName} (Delivery: ${job.deliveryNumber})`
    );

    // Create temp directory
    const { app } = require("electron");
    const tempDir = path.join(
      app ? app.getPath("temp") : process.cwd(),
      "funprinting-print"
    );
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Determine file extension
    let fileExtension = path.extname(job.fileName);
    if (!fileExtension || fileExtension === "") {
      fileExtension = job.fileType
        ? job.fileType.startsWith(".")
          ? job.fileType
          : `.${job.fileType}`
        : ".pdf";
    }

    const tempFilePath = path.join(
      tempDir,
      `${job.deliveryNumber}${fileExtension}`
    );
    const fileExtLower = fileExtension.toLowerCase();

    // Detect simple single-sheet jobs (skip order summary for these)
    const isImageJob = [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".bmp",
    ].includes(fileExtLower);
    const isPdfOrWordJob = [".pdf", ".doc", ".docx"].includes(
      fileExtLower
    );
    const pageCountFromOptions = job.printingOptions?.pageCount;
    const pagesFromOrderDetails = job.orderDetails?.pages;
    const isSinglePageDocJob =
      isPdfOrWordJob &&
      ((typeof pageCountFromOptions === "number" &&
        pageCountFromOptions <= 1) ||
        (typeof pagesFromOrderDetails === "number" &&
          pagesFromOrderDetails <= 1));
    const isSimpleSingleSheetJob = isImageJob || isSinglePageDocJob;

    console.log("🔍 Simple single-sheet detection:", {
      fileExtension: fileExtLower,
      isImageJob,
      isPdfOrWordJob,
      pageCountFromOptions,
      pagesFromOrderDetails,
      isSinglePageDocJob,
      isSimpleSingleSheetJob,
    });

    // Download
    console.log(`Downloading file from ${job.fileUrl}...`);
    await downloadFile(job.fileUrl, tempFilePath);
    console.log(`File downloaded to ${tempFilePath}`);

    // Print the file FIRST (will be at bottom of stack)
    console.log(`Printing file: ${tempFilePath}`);
    emitStatus(job.id || job.orderId, "Sending to printer...");
    await printFile(tempFilePath, job.printingOptions);
    console.log(`File printed successfully`);
    emitStatus(job.id || job.orderId, "Completed!");

    // Print order summary page LAST (appears on top — LIFO stack)
    if (
      job.orderDetails &&
      job.customerInfo &&
      !isSimpleSingleSheetJob
    ) {
      console.log(`Printing order summary page (non-simple job)...`);
      const orderSummaryPage = await generateOrderSummaryPage(
        job.orderDetails,
        job.customerInfo,
        job.orderId,
        new Date().toISOString()
      );
      const orderSummaryPath = path.join(
        tempDir,
        `order_summary_${job.deliveryNumber}.pdf`
      );
      fs.writeFileSync(orderSummaryPath, orderSummaryPage);
      await printFile(orderSummaryPath, {
        ...job.printingOptions,
        copies: 1,
      });
      fs.unlinkSync(orderSummaryPath);
      console.log(`Order summary page printed successfully`);
    } else if (isSimpleSingleSheetJob) {
      console.log(
        `⏭️ Skipping order summary page for simple single-sheet job`
      );
    } else {
      console.log(
        `⏭️ Skipping order summary page (orderDetails or customerInfo not provided)`
      );
      console.log(
        `   orderDetails: ${job.orderDetails ? "provided" : "missing"}`
      );
      console.log(
        `   customerInfo: ${job.customerInfo ? "provided" : "missing"}`
      );
    }

    // Cleanup
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    return {
      success: true,
      message: "Print job completed successfully",
      deliveryNumber: job.deliveryNumber,
    };
  } catch (error) {
    emitStatus(job.id || job.orderId, "Error: Print Failed");
    console.error("Error printing job:", error);

    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const errorLower = errorMessage.toLowerCase();

    let userMessage = "Failed to print job";
    let errorDetails = errorMessage;

    if (
      errorLower.includes("printer not connected") ||
      errorLower.includes("unable to connect") ||
      errorLower.includes("printer not found")
    ) {
      userMessage = "Printer not connected";
      errorDetails =
        "Please check USB connection and ensure printer is powered on";
    } else if (
      errorLower.includes("printer is offline") ||
      errorLower.includes("printer is not available") ||
      errorLower.includes("printer is stopped")
    ) {
      userMessage = "Printer is offline";
      errorDetails =
        "Printer may be powered off or disconnected. Please check power and USB connection.";
    } else if (
      errorLower.includes("power") &&
      errorLower.includes("off")
    ) {
      userMessage = "Printer appears to be powered off";
      errorDetails = "Please turn on the printer and try again";
    } else if (
      errorLower.includes("timeout") ||
      errorLower.includes("timed out")
    ) {
      userMessage = "Print job timed out";
      errorDetails =
        "Printer may be busy or not responding. Will retry automatically.";
    }

    return {
      success: false,
      message: userMessage,
      error: errorDetails,
      deliveryNumber: job.deliveryNumber,
    };
  }
}

module.exports = { printJob, emitStatus };
