//! The few PDFium functions the printer needs, loaded from pdfium.dll at runtime
//! (shipped next to the add-on). PDFium is not thread-safe: every call goes through the
//! one `Pdfium` value behind a mutex (see lib.rs).

use libloading::{Library, Symbol};
use std::ffi::{c_char, c_double, c_int, c_ulong, c_void, CString};

pub type FpdfDocument = *mut c_void;
pub type FpdfPage = *mut c_void;

/// FPDF_SetPrintMode values (public/fpdf_edit.h)
/// Vector GDI (EMF) output, with efficient image masks: any Windows driver.
pub const PRINTMODE_EMF_IMAGE_MASKS: c_int = 6;
/// PostScript level 2 / level 3 with Type 42 fonts, sent straight to a PostScript driver.
pub const PRINTMODE_POSTSCRIPT2_PASSTHROUGH: c_int = 4;
pub const PRINTMODE_POSTSCRIPT3_TYPE42_PASSTHROUGH: c_int = 8;
/// FPDF_RenderPage flags
pub const FLAG_ANNOT: c_int = 0x01;
pub const FLAG_GRAYSCALE: c_int = 0x08;
pub const FLAG_PRINTING: c_int = 0x800;

#[repr(C)]
struct LibraryConfig {
    version: c_int,
    user_font_paths: *const *const c_char,
    isolate: *mut c_void,
    v8_embedder_slot: u32,
    platform: *mut c_void,
    renderer_type: c_int,
}

type InitWithConfig = unsafe extern "system" fn(*const LibraryConfig);
type SetPrintMode = unsafe extern "system" fn(c_int) -> c_int;
type LoadDocument = unsafe extern "system" fn(*const c_char, *const c_char) -> FpdfDocument;
type CloseDocument = unsafe extern "system" fn(FpdfDocument);
type GetPageCount = unsafe extern "system" fn(FpdfDocument) -> c_int;
type LoadPage = unsafe extern "system" fn(FpdfDocument, c_int) -> FpdfPage;
type ClosePage = unsafe extern "system" fn(FpdfPage);
type GetLastError = unsafe extern "system" fn() -> c_ulong;
type RenderPage = unsafe extern "system" fn(*mut c_void, FpdfPage, c_int, c_int, c_int, c_int, c_int, c_int);
type GetPageSizeByIndex = unsafe extern "system" fn(FpdfDocument, c_int, *mut c_double, *mut c_double) -> c_int;

pub struct Pdfium {
    _lib: Library,
    set_print_mode: SetPrintMode,
    load_document: LoadDocument,
    close_document: CloseDocument,
    get_page_count: GetPageCount,
    load_page: LoadPage,
    close_page: ClosePage,
    get_last_error: GetLastError,
    render_page: RenderPage,
    page_size_by_index: GetPageSizeByIndex,
}

// The handles are only used while holding the global mutex
unsafe impl Send for Pdfium {}

fn sym<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
    unsafe {
        let s: Symbol<T> = lib.get(name).map_err(|e| format!("pdfium.dll has no {}: {e}", String::from_utf8_lossy(name)))?;
        Ok(*s)
    }
}

impl Pdfium {
    pub fn load(path: &str) -> Result<Self, String> {
        let lib = unsafe { Library::new(path) }.map_err(|e| format!("Could not load PDFium from {path}: {e}"))?;
        let init: InitWithConfig = sym(&lib, b"FPDF_InitLibraryWithConfig\0")?;
        let p = Pdfium {
            set_print_mode: sym(&lib, b"FPDF_SetPrintMode\0")?,
            load_document: sym(&lib, b"FPDF_LoadDocument\0")?,
            close_document: sym(&lib, b"FPDF_CloseDocument\0")?,
            get_page_count: sym(&lib, b"FPDF_GetPageCount\0")?,
            load_page: sym(&lib, b"FPDF_LoadPage\0")?,
            close_page: sym(&lib, b"FPDF_ClosePage\0")?,
            get_last_error: sym(&lib, b"FPDF_GetLastError\0")?,
            render_page: sym(&lib, b"FPDF_RenderPage\0")?,
            page_size_by_index: sym(&lib, b"FPDF_GetPageSizeByIndex\0")?,
            _lib: lib,
        };
        let config = LibraryConfig { version: 2, user_font_paths: std::ptr::null(), isolate: std::ptr::null_mut(), v8_embedder_slot: 0, platform: std::ptr::null_mut(), renderer_type: 0 };
        unsafe { init(&config) };
        Ok(p)
    }

    pub fn set_print_mode(&self, mode: c_int) -> bool {
        unsafe { (self.set_print_mode)(mode) != 0 }
    }

    pub fn open(&self, path: &str) -> Result<Document<'_>, String> {
        let c = CString::new(path).map_err(|_| "Invalid file path".to_string())?;
        let doc = unsafe { (self.load_document)(c.as_ptr(), std::ptr::null()) };
        if doc.is_null() {
            let code = unsafe { (self.get_last_error)() };
            return Err(match code {
                2 => "The PDF file was not found".into(),
                3 => "The PDF file is damaged".into(),
                4 => "The PDF file is password-protected".into(),
                5 => "The PDF file uses unsupported security".into(),
                _ => format!("The PDF file could not be opened (PDFium error {code})"),
            });
        }
        Ok(Document { pdfium: self, doc })
    }
}

pub struct Document<'a> {
    pdfium: &'a Pdfium,
    doc: FpdfDocument,
}

impl<'a> Document<'a> {
    pub fn page_count(&self) -> u32 {
        unsafe { (self.pdfium.get_page_count)(self.doc).max(0) as u32 }
    }

    /// Page size in points, without loading the page.
    pub fn page_size(&self, index: u32) -> (f64, f64) {
        let (mut w, mut h) = (0.0, 0.0);
        unsafe { (self.pdfium.page_size_by_index)(self.doc, index as c_int, &mut w, &mut h) };
        (w, h)
    }

    /// Draws page `index` onto the device context.
    pub fn render(&self, index: u32, hdc: *mut c_void, x: i32, y: i32, w: i32, h: i32, rotate: i32, flags: c_int) -> Result<(), String> {
        let page = unsafe { (self.pdfium.load_page)(self.doc, index as c_int) };
        if page.is_null() {
            return Err(format!("Page {} could not be read", index + 1));
        }
        unsafe {
            (self.pdfium.render_page)(hdc, page, x, y, w, h, rotate, flags);
            (self.pdfium.close_page)(page);
        }
        Ok(())
    }
}

impl Drop for Document<'_> {
    fn drop(&mut self) {
        unsafe { (self.pdfium.close_document)(self.doc) };
    }
}
