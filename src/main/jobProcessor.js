/**
 * Incoming job processor — handles multi-file and single-file jobs,
 * deduplicates, and dispatches to queue + UI
 */

function processIncomingJob(job, source, getMainWindow) {
  const printQueue = require('../../chrome-queue');

  // Deduplicate — skip if already in queue
  const queueStatus = printQueue.getQueueStatus();
  const alreadyQueued = queueStatus.jobs.some(qj =>
    qj.job && qj.job.orderId === (job.orderId || job.jobId)
  );
  if (alreadyQueued) {
    console.log(`⏭️ Job ${job.jobId} already in queue, skipping duplicate injection.`);
    return;
  }

  console.log(`📥 Job Injected to Advanced Queue (${source}):`, job.jobId);

  const hasMultipleFiles = job.fileURLs && job.fileURLs.length > 0;

  if (hasMultipleFiles) {
    _processMultiFileJob(job, source, getMainWindow, printQueue);
  } else {
    _processSingleFileJob(job, source, getMainWindow, printQueue);
  }
}

function _buildPrintOptions(job) {
  const opts = job.options || {
    pageSize: 'A4',
    color: 'bw',
    sided: 'single',
    copies: 1
  };

  if (job.options && job.options.isMonochrome) {
    opts.color = 'bw';
  } else if (job.options && job.options.isMonochrome === false) {
    opts.color = 'color';
  }

  return opts;
}

function _processMultiFileJob(job, source, getMainWindow, printQueue) {
  const mainWindow = getMainWindow();

  for (let i = 0; i < job.fileURLs.length; i++) {
    const apiJob = {
      orderId: job.orderId || job.jobId,
      fileUrl: job.fileURLs[i],
      fileName: job.originalFileNames ? job.originalFileNames[i] : `File ${i + 1}`,
      fileType: job.fileTypes ? job.fileTypes[i] : 'pdf',
      printingOptions: _buildPrintOptions(job),
      orderDetails: job.orderDetails,
      customerInfo: job.customer
    };

    printQueue.addToQueue(apiJob, 0);

    if (mainWindow && !mainWindow.isDestroyed()) {
      const uiJob = {
        ...job,
        jobId: `${job.jobId}-${i + 1}`,
        options: apiJob.printingOptions
      };
      mainWindow.webContents.send('incoming_job', uiJob);
    }
  }
}

function _processSingleFileJob(job, source, getMainWindow, printQueue) {
  const mainWindow = getMainWindow();
  const fileUrl = job.url || job.documentUrl;

  const apiJob = {
    orderId: job.orderId || job.jobId,
    fileUrl: fileUrl,
    fileName: job.originalFileName || (fileUrl ? fileUrl.split('/').pop().split('?')[0] : 'document.pdf'),
    fileType: 'pdf',
    printingOptions: _buildPrintOptions(job),
    orderDetails: job.orderDetails,
    customerInfo: job.customer
  };

  printQueue.addToQueue(apiJob, 0);

  if (mainWindow && !mainWindow.isDestroyed()) {
    job.options = apiJob.printingOptions;
    mainWindow.webContents.send('incoming_job', job);
  }
}

module.exports = { processIncomingJob };
