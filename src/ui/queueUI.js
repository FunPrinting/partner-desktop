/**
 * Print queue UI — job cards, AIMD progress, resume/complete actions
 */

function initQueueUI() {
  const queueContainer = document.getElementById('queue-container');

  // ── Render a new job card ──────────────────────────────────────────

  window.renderJobCard = function renderJobCard(job) {
    // Remove empty state placeholder
    if (queueContainer.children.length === 1 &&
        queueContainer.children[0].tagName === 'DIV' &&
        queueContainer.children[0].classList.contains('justify-center')) {
      queueContainer.innerHTML = '';
    }

    const jobId = job.jobId || job.orderId || Math.random().toString(36).substr(2, 9);
    const displayId = jobId.substring(0, 8).toUpperCase();

    const jobCard = document.createElement('div');
    jobCard.id = `job-${jobId}`;
    jobCard.className = "glass-panel rounded-xl p-5 border-l-4 border-l-indigo-500 shadow-md";

    jobCard.innerHTML = `
      <div class="flex justify-between items-start mb-4">
        <div>
          <div class="flex items-center gap-3 mb-1">
            <h3 class="font-bold text-lg text-gray-900">Job ID: ${displayId}</h3>
            <span id="badge-${jobId}" class="px-2 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-400 border border-blue-800/50">Processing</span>
          </div>
          <p class="text-xs text-gray-500 flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            Received just now
          </p>
        </div>
        <div class="text-right text-sm text-gray-600">
          <p><span class="text-gray-500">Size:</span> ${job.options?.pageSize || 'A4'}</p>
          <p><span class="text-gray-500">Color:</span> ${job.options?.color || 'bw'}</p>
          <p><span class="text-gray-500">Sided:</span> ${job.options?.sided || 'single'}</p>
        </div>
      </div>

      <!-- AIMD Status Area -->
      <div class="bg-white rounded-lg p-4 border border-gray-200">
        <div class="flex justify-between text-xs mb-2">
          <span class="text-gray-500">AIMD Engine Status</span>
          <span id="status-text-${jobId}" class="font-medium text-gray-900">Slicing PDF...</span>
        </div>
        <div class="w-full bg-gray-50 rounded-full h-2 mb-2 overflow-hidden">
          <div id="progress-${jobId}" class="bg-indigo-500 h-2 rounded-full transition-all duration-500" style="width: 10%"></div>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-gray-500">Congestion Window (Packet Size)</span>
          <span id="cwnd-${jobId}" class="font-mono text-blue-600 bg-indigo-900/30 px-2 rounded border border-indigo-800/50">5 pages</span>
        </div>
      </div>
    `;
    queueContainer.prepend(jobCard);
  };

  window.electronAPI.onIncomingJob(renderJobCard);

  // ── AIMD Print Status Updates ──────────────────────────────────────

  window.electronAPI.onPrintStatus((data) => {
    const badge = document.getElementById(`badge-${data.jobId}`);
    const statusText = document.getElementById(`status-text-${data.jobId}`);
    const cwnd = document.getElementById(`cwnd-${data.jobId}`);
    const progress = document.getElementById(`progress-${data.jobId}`);
    const jobCard = document.getElementById(`job-${data.jobId}`);

    if (badge && statusText && cwnd && progress) {
      statusText.innerText = data.status;
      cwnd.innerText = `${data.packetSize} pages`;

      if (data.status.includes('Error')) {
        _handleJobError(data, badge, statusText, progress, jobCard);
      }
      else if (data.status === 'Completed') {
        _handleJobComplete(data, badge, statusText, progress, jobCard);
      }
      else {
        progress.style.width = Math.min(parseInt(progress.style.width) + 20, 90) + "%";
      }
    }
  });

  // ── Private Helpers ────────────────────────────────────────────────

  function _handleJobError(data, badge, statusText, progress, jobCard) {
    badge.className = "px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-600 border border-red-200 animate-pulse";
    badge.innerText = "ERROR";
    statusText.className = "font-bold text-red-600";
    progress.className = "bg-red-500 h-2 rounded-full transition-all duration-500";
    jobCard.classList.replace('border-l-indigo-500', 'border-l-red-500');
    jobCard.classList.add('bg-red-900/10');

    if (!document.getElementById(`resume-${data.jobId}`)) {
      const btn = document.createElement('button');
      btn.id = `resume-${data.jobId}`;
      btn.className = "mt-3 w-full py-2 bg-red-600 hover:bg-red-500 text-gray-900 text-sm font-bold rounded-lg shadow-lg shadow-red-600/20";
      btn.innerText = "Jam Cleared - Resume Printing (1 page packet)";
      btn.onclick = () => {
        btn.innerText = "Resuming...";
        btn.disabled = true;
        window.electronAPI.resumePrint(data.jobId);
        setTimeout(() => { btn.remove(); }, 1000);
      };
      jobCard.appendChild(btn);
    }
  }

  function _handleJobComplete(data, badge, statusText, progress, jobCard) {
    badge.className = "px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700 border border-green-200";
    badge.innerText = "COMPLETED";
    statusText.className = "font-medium text-green-700";
    progress.className = "bg-green-500 h-2 rounded-full transition-all duration-500";
    progress.style.width = "100%";
    jobCard.classList.replace('border-l-indigo-500', 'border-l-green-500');

    if (!document.getElementById(`actions-${data.jobId}`)) {
      const actionsDiv = document.createElement('div');
      actionsDiv.id = `actions-${data.jobId}`;
      actionsDiv.className = "mt-4 flex gap-2 border-t border-gray-200 pt-3";

      const readyBtn = document.createElement('button');
      readyBtn.className = "flex-1 py-2 bg-blue-600 hover:bg-indigo-500 text-gray-900 text-xs font-bold rounded-lg shadow-md";
      readyBtn.innerText = "Mark Ready for Pickup";
      readyBtn.onclick = () => {
        readyBtn.innerText = "Updating...";
        window.electronAPI.updateOrderStatus(data.jobId, 'ready_for_pickup').then(() => {
          readyBtn.innerText = "Ready ✓";
          readyBtn.className = "flex-1 py-2 bg-green-600 text-gray-900 text-xs font-bold rounded-lg shadow-md";
        });
      };

      const deliveredBtn = document.createElement('button');
      deliveredBtn.className = "flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-900 text-xs font-bold rounded-lg shadow-md";
      deliveredBtn.innerText = "Mark Delivered";
      deliveredBtn.onclick = () => {
        deliveredBtn.innerText = "Updating...";
        window.electronAPI.updateOrderStatus(data.jobId, 'delivered').then(() => {
          jobCard.style.opacity = '0.5';
          deliveredBtn.innerText = "Delivered ✓";
        });
      };

      actionsDiv.appendChild(readyBtn);
      actionsDiv.appendChild(deliveredBtn);
      jobCard.appendChild(actionsDiv);
    }
  }
}
