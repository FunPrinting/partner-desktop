//! Windows printing through GDI, the same path Chrome uses for PDFs: PDFium draws each
//! page onto the printer's device context as vector commands (or as PostScript for
//! PostScript drivers), so the spooled job is small and the printer gets sharp text.
//!
//! Settings go in the job's own DEVMODE, checked with the driver first (DocumentProperties
//! merge), so the system defaults are never changed and the driver never refuses an
//! option. B&W is also enforced in rendering (FPDF_GRAYSCALE), for drivers that ignore it.

#![cfg(windows)]

use crate::layout::{page_sequence, place, plan_copies, Copies, Device};
use crate::pdfium::{Pdfium, FLAG_ANNOT, FLAG_GRAYSCALE, FLAG_PRINTING, PRINTMODE_EMF_IMAGE_MASKS, PRINTMODE_POSTSCRIPT2_PASSTHROUGH, PRINTMODE_POSTSCRIPT3_TYPE42_PASSTHROUGH};
use std::ffi::c_void;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, DeleteDC, GetDeviceCaps, DEVMODEW, DMCOLLATE_TRUE, DMCOLOR_COLOR, DMCOLOR_MONOCHROME, DMDUP_SIMPLEX, DMDUP_VERTICAL, DM_COLLATE, DM_COLOR, DM_COPIES, DM_DUPLEX,
    DM_ORIENTATION, DM_PAPERSIZE, HDC, HORZRES, PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH, VERTRES,
};
use windows::Win32::Graphics::Printing::{
    ClosePrinter, DocumentPropertiesW, EnumPrintersW, GetDefaultPrinterW, GetJobW, OpenPrinterW, SetJobW, JOB_CONTROL_DELETE, JOB_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_HANDLE, PRINTER_INFO_2W,
};
use windows::Win32::Storage::Xps::{
    AbortDoc, DeviceCapabilitiesW, EndDoc, EndPage, ExtEscape, StartDocW, StartPage, DC_COLLATE, DC_COLORDEVICE, DC_COPIES, DC_DUPLEX, DC_PAPERS, DOCINFOW, PRINTER_DEVICE_CAPABILITIES,
};

const DM_IN_BUFFER: u32 = 8;
const DM_OUT_BUFFER: u32 = 2;
const DMPAPER_A3: i16 = 8;
const DMPAPER_A4: i16 = 9;
const DMORIENT_PORTRAIT: i16 = 1;
const QUERYESCSUPPORT: i32 = 8;
const PASSTHROUGH: i32 = 19;
const POSTSCRIPT_PASSTHROUGH: i32 = 4115;
const GETTECHNOLOGY: i32 = 20;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn from_wide(p: PWSTR) -> String {
    if p.is_null() {
        String::new()
    } else {
        p.to_string().unwrap_or_default()
    }
}

/// Owns a printer handle.
struct Printer(PRINTER_HANDLE);
impl Printer {
    fn open(name: &[u16]) -> Result<Self, PrintFail> {
        let mut h = PRINTER_HANDLE::default();
        unsafe { OpenPrinterW(PCWSTR(name.as_ptr()), &mut h, None) }.map_err(|_| PrintFail::not_found())?;
        Ok(Printer(h))
    }
}
impl Drop for Printer {
    fn drop(&mut self) {
        unsafe {
            let _ = ClosePrinter(self.0);
        }
    }
}

/// Owns a printer device context.
struct Dc(HDC);
impl Drop for Dc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

#[derive(Debug)]
pub struct PrintFail {
    pub code: &'static str,
    pub message: String,
}
impl PrintFail {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        PrintFail { code, message: message.into() }
    }
    fn not_found() -> Self {
        Self::new("PRINTER_NOT_FOUND", "The printer was not found")
    }
    fn driver(what: &str) -> Self {
        let err = unsafe { GetLastError() };
        Self::new("DRIVER_FAILED", format!("The printer driver failed ({what}, error {})", err.0))
    }
}

// ── Printers ───────────────────────────────────────────────────────────

pub struct PrinterInfo {
    pub name: String,
    pub port: String,
    pub driver: String,
    pub location: String,
    pub comment: String,
    pub status: u32,
    pub attributes: u32,
    pub jobs: u32,
    pub is_default: bool,
}

fn default_printer() -> String {
    unsafe {
        let mut len = 0u32;
        let _ = GetDefaultPrinterW(None, &mut len);
        if len == 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize];
        if GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut len).as_bool() {
            String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)])
        } else {
            String::new()
        }
    }
}

pub fn list_printers() -> Result<Vec<PrinterInfo>, PrintFail> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let (mut needed, mut count) = (0u32, 0u32);
    unsafe {
        let _ = EnumPrintersW(flags, PCWSTR::null(), 2, None, &mut needed, &mut count);
    }
    if needed == 0 {
        return Ok(vec![]);
    }
    // Allocate as u64 so PRINTER_INFO_2W is aligned
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let bytes = unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, buf.len() * 8) };
    unsafe { EnumPrintersW(flags, PCWSTR::null(), 2, Some(bytes), &mut needed, &mut count) }.map_err(|e| PrintFail::new("DRIVER_FAILED", format!("Could not list printers: {e}")))?;
    let def = default_printer();
    let infos = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_2W, count as usize) };
    Ok(infos
        .iter()
        .map(|i| unsafe {
            let name = from_wide(i.pPrinterName);
            PrinterInfo {
                is_default: name == def,
                name,
                port: from_wide(i.pPortName),
                driver: from_wide(i.pDriverName),
                location: from_wide(i.pLocation),
                comment: from_wide(i.pComment),
                status: i.Status,
                attributes: i.Attributes,
                jobs: i.cJobs,
            }
        })
        .collect())
}

fn port_of(name: &str) -> String {
    list_printers().ok().and_then(|l| l.into_iter().find(|p| p.name == name)).map(|p| p.port).unwrap_or_default()
}

pub struct Caps {
    pub color: bool,
    pub duplex: bool,
    pub papers: Vec<i16>,
    pub max_copies: u32,
    pub collate: bool,
}

fn device_cap(name: &[u16], port: &[u16], cap: PRINTER_DEVICE_CAPABILITIES, out: Option<PWSTR>) -> i32 {
    unsafe { DeviceCapabilitiesW(PCWSTR(name.as_ptr()), PCWSTR(port.as_ptr()), cap, out, None) }
}

pub fn capabilities(name: &str) -> Result<Caps, PrintFail> {
    let w = wide(name);
    let port = wide(&port_of(name));
    let _ = Printer::open(&w)?; // fails clearly when the printer is gone
    let n = device_cap(&w, &port, DC_PAPERS, None);
    let mut papers = vec![0i16; n.max(0) as usize];
    if n > 0 {
        device_cap(&w, &port, DC_PAPERS, Some(PWSTR(papers.as_mut_ptr() as *mut u16)));
    }
    Ok(Caps {
        color: device_cap(&w, &port, DC_COLORDEVICE, None) == 1,
        duplex: device_cap(&w, &port, DC_DUPLEX, None) == 1,
        papers,
        max_copies: device_cap(&w, &port, DC_COPIES, None).max(1) as u32,
        collate: device_cap(&w, &port, DC_COLLATE, None) == 1,
    })
}

// ── Printing ───────────────────────────────────────────────────────────

pub struct Job<'a> {
    pub printer: &'a str,
    pub file: &'a str,
    pub title: &'a str,
    pub copies: u32,
    pub duplex: bool,
    pub color: bool,
    /// "A4" or "A3"
    pub paper: &'a str,
}

pub struct Printed {
    pub job_id: u32,
    pub pages: u32,
    pub sheets_sent: u32,
    pub mode: &'static str,
    pub driver_copies: bool,
}

/// The job's DEVMODE: the printer's defaults with our settings, merged by the driver.
fn job_devmode(printer: &Printer, name: &[u16], job: &Job, caps: &Caps, copies: Copies) -> Result<Vec<u64>, PrintFail> {
    let size = unsafe { DocumentPropertiesW(None, printer.0, PCWSTR(name.as_ptr()), None, None, 0) };
    if size <= 0 {
        return Err(PrintFail::driver("DocumentProperties"));
    }
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    let dm = buf.as_mut_ptr() as *mut DEVMODEW;
    if unsafe { DocumentPropertiesW(None, printer.0, PCWSTR(name.as_ptr()), Some(dm), None, DM_OUT_BUFFER) } < 0 {
        return Err(PrintFail::driver("DocumentProperties"));
    }
    unsafe {
        let d = &mut *dm;
        let paper = if job.paper == "A3" { DMPAPER_A3 } else { DMPAPER_A4 };
        if caps.papers.contains(&paper) {
            d.Anonymous1.Anonymous1.dmPaperSize = paper;
            d.dmFields |= DM_PAPERSIZE;
        }
        // Pages are turned to fit in rendering; the paper stays portrait
        d.Anonymous1.Anonymous1.dmOrientation = DMORIENT_PORTRAIT;
        d.dmFields |= DM_ORIENTATION;
        if caps.duplex {
            d.dmDuplex = if job.duplex { DMDUP_VERTICAL } else { DMDUP_SIMPLEX };
            d.dmFields |= DM_DUPLEX;
        }
        if caps.color {
            d.dmColor = if job.color { DMCOLOR_COLOR } else { DMCOLOR_MONOCHROME };
            d.dmFields |= DM_COLOR;
        }
        let n = match copies {
            Copies::Driver(n) => n,
            Copies::Repeat { .. } => 1,
        };
        d.Anonymous1.Anonymous1.dmCopies = n.min(i16::MAX as u32) as i16;
        d.dmFields |= DM_COPIES;
        if n > 1 && caps.collate {
            d.dmCollate = DMCOLLATE_TRUE;
            d.dmFields |= DM_COLLATE;
        }
        // Let the driver check and merge the settings (it drops what it can't do)
        if DocumentPropertiesW(None, printer.0, PCWSTR(name.as_ptr()), Some(dm), Some(dm as *const DEVMODEW), DM_IN_BUFFER | DM_OUT_BUFFER) < 0 {
            return Err(PrintFail::driver("DocumentProperties merge"));
        }
    }
    Ok(buf)
}

/// PostScript drivers get PostScript straight from PDFium (fastest, exact); every other
/// driver gets vector EMF.
fn choose_mode(hdc: HDC) -> (i32, &'static str) {
    unsafe {
        let mut tech = [0u8; 64];
        let n = ExtEscape(hdc, GETTECHNOLOGY, None, Some(&mut tech));
        let is_ps = n > 0 && String::from_utf8_lossy(&tech).to_ascii_lowercase().contains("postscript");
        let supports = |esc: i32| ExtEscape(hdc, QUERYESCSUPPORT, Some(&esc.to_ne_bytes()), None) > 0;
        if is_ps && supports(PASSTHROUGH) {
            return (PRINTMODE_POSTSCRIPT3_TYPE42_PASSTHROUGH, "postscript3");
        }
        if is_ps && supports(POSTSCRIPT_PASSTHROUGH) {
            return (PRINTMODE_POSTSCRIPT2_PASSTHROUGH, "postscript2");
        }
    }
    (PRINTMODE_EMF_IMAGE_MASKS, "emf")
}

fn device(hdc: HDC) -> Device {
    unsafe {
        Device {
            printable_w: GetDeviceCaps(Some(hdc), HORZRES),
            printable_h: GetDeviceCaps(Some(hdc), VERTRES),
            paper_w: GetDeviceCaps(Some(hdc), PHYSICALWIDTH),
            paper_h: GetDeviceCaps(Some(hdc), PHYSICALHEIGHT),
            offset_x: GetDeviceCaps(Some(hdc), PHYSICALOFFSETX),
            offset_y: GetDeviceCaps(Some(hdc), PHYSICALOFFSETY),
        }
    }
}

pub fn print(pdfium: &Pdfium, job: &Job) -> Result<Printed, PrintFail> {
    let name = wide(job.printer);
    let printer = Printer::open(&name)?;
    let caps = capabilities(job.printer)?;
    let doc = pdfium.open(job.file).map_err(|m| PrintFail::new("FILE_UNREADABLE", m))?;
    let pages = doc.page_count();
    if pages == 0 {
        return Err(PrintFail::new("FILE_UNREADABLE", "The PDF has no pages"));
    }
    let copies = plan_copies(job.copies, pages, job.duplex && caps.duplex, caps.max_copies, caps.collate);
    let devmode = job_devmode(&printer, &name, job, &caps, copies)?;
    drop(printer);

    let winspool = wide("WINSPOOL");
    let hdc = unsafe { CreateDCW(PCWSTR(winspool.as_ptr()), PCWSTR(name.as_ptr()), PCWSTR::null(), Some(devmode.as_ptr() as *const DEVMODEW)) };
    if hdc.is_invalid() {
        return Err(PrintFail::driver("CreateDC"));
    }
    let dc = Dc(hdc);
    let (mode, mode_name) = choose_mode(dc.0);
    pdfium.set_print_mode(mode);
    let dev = device(dc.0);
    if dev.printable_w <= 0 || dev.printable_h <= 0 {
        return Err(PrintFail::driver("the printer reported no printable area"));
    }

    let title = wide(job.title);
    let info = DOCINFOW { cbSize: std::mem::size_of::<DOCINFOW>() as i32, lpszDocName: PCWSTR(title.as_ptr()), ..Default::default() };
    let job_id = unsafe { StartDocW(dc.0, &info) };
    if job_id <= 0 {
        return Err(PrintFail::driver("StartDoc"));
    }
    let mut flags = FLAG_ANNOT | FLAG_PRINTING;
    if !job.color {
        flags |= FLAG_GRAYSCALE;
    }

    let mut sent = 0u32;
    let result = (|| -> Result<(), PrintFail> {
        for entry in page_sequence(pages, copies) {
            if unsafe { StartPage(dc.0) } <= 0 {
                return Err(PrintFail::driver("StartPage"));
            }
            if let Some(index) = entry {
                let (w, h) = doc.page_size(index);
                let p = place(w, h, dev);
                doc.render(index, dc.0 .0 as *mut c_void, p.x, p.y, p.w, p.h, p.rotate, flags).map_err(|m| PrintFail::new("FILE_UNREADABLE", m))?;
            }
            if unsafe { EndPage(dc.0) } <= 0 {
                return Err(PrintFail::driver("EndPage"));
            }
            sent += 1;
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            if unsafe { EndDoc(dc.0) } <= 0 {
                return Err(PrintFail::driver("EndDoc"));
            }
            Ok(Printed { job_id: job_id as u32, pages, sheets_sent: sent, mode: mode_name, driver_copies: matches!(copies, Copies::Driver(n) if n > 1) })
        }
        Err(e) => {
            unsafe { AbortDoc(dc.0) };
            Err(e)
        }
    }
}

// ── Job status ─────────────────────────────────────────────────────────

pub struct JobStatus {
    pub found: bool,
    pub status: u32,
    pub status_text: String,
    pub pages_printed: u32,
    pub total_pages: u32,
}

pub fn job_status(printer: &str, job_id: u32) -> Result<JobStatus, PrintFail> {
    let name = wide(printer);
    let p = Printer::open(&name)?;
    let mut needed = 0u32;
    unsafe {
        let _ = GetJobW(p.0, job_id, 1, None, &mut needed);
    }
    let err = unsafe { GetLastError() };
    if needed == 0 {
        // ERROR_INVALID_PARAMETER: the job is no longer in the queue (finished or deleted)
        if err == ERROR_INVALID_PARAMETER || err != ERROR_INSUFFICIENT_BUFFER {
            return Ok(JobStatus { found: false, status: 0, status_text: String::new(), pages_printed: 0, total_pages: 0 });
        }
    }
    let mut buf = vec![0u64; (needed as usize).div_ceil(8).max(1)];
    let bytes = unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, buf.len() * 8) };
    if !unsafe { GetJobW(p.0, job_id, 1, Some(bytes), &mut needed) }.as_bool() {
        return Ok(JobStatus { found: false, status: 0, status_text: String::new(), pages_printed: 0, total_pages: 0 });
    }
    let info = unsafe { &*(buf.as_ptr() as *const JOB_INFO_1W) };
    Ok(JobStatus { found: true, status: info.Status, status_text: unsafe { from_wide(info.pStatus) }, pages_printed: info.PagesPrinted, total_pages: info.TotalPages })
}

pub fn cancel_job(printer: &str, job_id: u32) -> Result<(), PrintFail> {
    let name = wide(printer);
    let p = Printer::open(&name)?;
    // Fails only when the job already left the queue, which is what we want anyway
    let _ = unsafe { SetJobW(p.0, job_id, 0, None, JOB_CONTROL_DELETE) };
    Ok(())
}
