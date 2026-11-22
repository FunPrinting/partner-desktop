//! fp-print: the Windows print engine of FunPrinting Partner, as a Node add-on.
//!
//! JavaScript API (see src/print/engines/windowsEngine.js):
//!   init(pdfiumDllPath)                    loads PDFium once
//!   listPrinters()        -> PrinterInfo[]
//!   capabilities(name)    -> Caps
//!   print(job)            -> Promise<Printed>   renders on a worker thread
//!   jobStatus(name, id)   -> JobStatus
//!   cancelJob(name, id)
//!
//! Errors carry a code in the message prefix: "PRINTER_NOT_FOUND: ...", so JavaScript
//! can map them to PrintError codes.

#[macro_use]
extern crate napi_derive;

pub mod layout;
#[cfg_attr(not(windows), allow(dead_code))]
mod pdfium;
#[cfg(windows)]
mod winprint;

use napi::{Error, Result, Status};
use std::sync::Mutex;

#[cfg_attr(not(windows), allow(dead_code))]
static PDFIUM: Mutex<Option<pdfium::Pdfium>> = Mutex::new(None);

fn fail(code: &str, message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}: {message}"))
}

#[napi(object)]
pub struct PrinterInfo {
    pub name: String,
    pub port: String,
    pub driver: String,
    pub location: String,
    pub comment: String,
    /// PRINTER_STATUS_* flags
    pub status: u32,
    /// PRINTER_ATTRIBUTE_* flags
    pub attributes: u32,
    pub jobs: u32,
    pub is_default: bool,
}

#[napi(object)]
pub struct Caps {
    pub color: bool,
    pub duplex: bool,
    /// DMPAPER_* ids (A4 = 9, A3 = 8)
    pub papers: Vec<i32>,
    pub max_copies: u32,
    pub collate: bool,
}

#[napi(object)]
pub struct PrintJob {
    pub printer: String,
    pub file: String,
    pub title: String,
    pub copies: u32,
    pub duplex: bool,
    pub color: bool,
    pub paper: String,
}

#[napi(object)]
pub struct Printed {
    pub job_id: u32,
    pub pages: u32,
    pub sheets_sent: u32,
    /// "emf", "postscript3" or "postscript2"
    pub mode: String,
    pub driver_copies: bool,
}

#[napi(object)]
pub struct JobStatus {
    pub found: bool,
    /// JOB_STATUS_* flags
    pub status: u32,
    pub status_text: String,
    pub pages_printed: u32,
    pub total_pages: u32,
}

#[napi]
pub fn init(pdfium_path: String) -> Result<()> {
    let mut guard = PDFIUM.lock().map_err(|_| fail("UNKNOWN", "PDFium lock poisoned"))?;
    if guard.is_none() {
        *guard = Some(pdfium::Pdfium::load(&pdfium_path).map_err(|m| fail("DRIVER_FAILED", m))?);
    }
    Ok(())
}

#[cfg(windows)]
#[napi]
pub fn list_printers() -> Result<Vec<PrinterInfo>> {
    let list = winprint::list_printers().map_err(|e| fail(e.code, e.message))?;
    Ok(list
        .into_iter()
        .map(|p| PrinterInfo { name: p.name, port: p.port, driver: p.driver, location: p.location, comment: p.comment, status: p.status, attributes: p.attributes, jobs: p.jobs, is_default: p.is_default })
        .collect())
}

#[cfg(windows)]
#[napi]
pub fn capabilities(name: String) -> Result<Caps> {
    let c = winprint::capabilities(&name).map_err(|e| fail(e.code, e.message))?;
    Ok(Caps { color: c.color, duplex: c.duplex, papers: c.papers.into_iter().map(i32::from).collect(), max_copies: c.max_copies, collate: c.collate })
}

#[cfg_attr(not(windows), allow(dead_code))]
pub struct PrintTask(PrintJob);

#[cfg(windows)]
impl napi::Task for PrintTask {
    type Output = Printed;
    type JsValue = Printed;

    fn compute(&mut self) -> Result<Printed> {
        let guard = PDFIUM.lock().map_err(|_| fail("UNKNOWN", "PDFium lock poisoned"))?;
        let pdfium = guard.as_ref().ok_or_else(|| fail("DRIVER_FAILED", "init() was not called"))?;
        let j = &self.0;
        let job = winprint::Job { printer: &j.printer, file: &j.file, title: &j.title, copies: j.copies, duplex: j.duplex, color: j.color, paper: &j.paper };
        let p = winprint::print(pdfium, &job).map_err(|e| fail(e.code, e.message))?;
        Ok(Printed { job_id: p.job_id, pages: p.pages, sheets_sent: p.sheets_sent, mode: p.mode.to_string(), driver_copies: p.driver_copies })
    }

    fn resolve(&mut self, _env: napi::Env, output: Printed) -> Result<Printed> {
        Ok(output)
    }
}

/// Prints on a worker thread, so the app stays responsive while pages render.
#[cfg(windows)]
#[napi(ts_return_type = "Promise<Printed>")]
pub fn print(job: PrintJob) -> napi::bindgen_prelude::AsyncTask<PrintTask> {
    napi::bindgen_prelude::AsyncTask::new(PrintTask(job))
}

#[cfg(windows)]
#[napi]
pub fn job_status(printer: String, job_id: u32) -> Result<JobStatus> {
    let s = winprint::job_status(&printer, job_id).map_err(|e| fail(e.code, e.message))?;
    Ok(JobStatus { found: s.found, status: s.status, status_text: s.status_text, pages_printed: s.pages_printed, total_pages: s.total_pages })
}

#[cfg(windows)]
#[napi]
pub fn cancel_job(printer: String, job_id: u32) -> Result<()> {
    winprint::cancel_job(&printer, job_id).map_err(|e| fail(e.code, e.message))
}
