//! Platform-independent print layout: where a PDF page goes on the paper, and how copies
//! are made. Pure functions, tested on every platform.

/// The printable part of the paper, in device pixels, from GetDeviceCaps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Device {
    /// Printable area (HORZRES, VERTRES); the DC origin is its top-left corner.
    pub printable_w: i32,
    pub printable_h: i32,
    /// Whole sheet (PHYSICALWIDTH, PHYSICALHEIGHT) and the printable area's offset on it.
    pub paper_w: i32,
    pub paper_h: i32,
    pub offset_x: i32,
    pub offset_y: i32,
}

/// Where to draw one page: a rectangle in DC coordinates and a PDFium rotation
/// (0 = none, 1 = 90 degrees clockwise).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub rotate: i32,
}

/// Fits a page of `page_w` x `page_h` points into the printable area, keeping its shape.
/// A landscape page on portrait paper (or the reverse) is turned 90 degrees, so it is as
/// large as possible. The page is centred on the sheet, kept inside the printable area.
pub fn place(page_w: f64, page_h: f64, dev: Device) -> Placement {
    let page_landscape = page_w > page_h;
    let paper_landscape = dev.printable_w > dev.printable_h;
    let rotate = if page_landscape != paper_landscape { 1 } else { 0 };
    // Size of the page as it lands on the paper
    let (pw, ph) = if rotate == 1 { (page_h, page_w) } else { (page_w, page_h) };
    let pw = pw.max(1.0);
    let ph = ph.max(1.0);
    let scale = (dev.printable_w as f64 / pw).min(dev.printable_h as f64 / ph);
    let w = ((pw * scale).floor() as i32).clamp(1, dev.printable_w.max(1));
    let h = ((ph * scale).floor() as i32).clamp(1, dev.printable_h.max(1));
    // Centre on the physical sheet, then convert to printable-area coordinates
    let cx = (dev.paper_w - w) / 2 - dev.offset_x;
    let cy = (dev.paper_h - h) / 2 - dev.offset_y;
    let x = cx.clamp(0, (dev.printable_w - w).max(0));
    let y = cy.clamp(0, (dev.printable_h - h).max(0));
    Placement { x, y, w, h, rotate }
}

/// How copies are made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Copies {
    /// The driver prints `n` collated copies of one spooled document (fastest).
    Driver(u32),
    /// The document is sent `n` times inside one job. For double-sided printing a blank
    /// page is added after an odd page count, so each copy starts on a new sheet.
    Repeat { n: u32, pad_blank: bool },
}

/// Uses the driver's copies when it supports enough of them, and collation when the
/// document has more than one page; otherwise repeats the pages.
pub fn plan_copies(copies: u32, pages: u32, duplex: bool, driver_max_copies: u32, driver_collates: bool) -> Copies {
    let n = copies.max(1);
    if n == 1 {
        return Copies::Driver(1);
    }
    if driver_max_copies >= n && (pages <= 1 || driver_collates) {
        return Copies::Driver(n);
    }
    Copies::Repeat { n, pad_blank: duplex && pages % 2 == 1 }
}

/// The page indexes (0-based) to render, in order; `None` is a blank page.
pub fn page_sequence(pages: u32, copies: Copies) -> Vec<Option<u32>> {
    match copies {
        Copies::Driver(_) => (0..pages).map(Some).collect(),
        Copies::Repeat { n, pad_blank } => {
            let mut out = Vec::new();
            for c in 0..n {
                out.extend((0..pages).map(Some));
                // No blank after the last copy
                if pad_blank && c + 1 < n {
                    out.push(None);
                }
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A4 at 600 dpi with ~4 mm margins
    const A4_600: Device = Device { printable_w: 4760, printable_h: 6814, paper_w: 4960, paper_h: 7014, offset_x: 100, offset_y: 100 };

    #[test]
    fn a4_page_fills_the_printable_area() {
        let p = place(595.28, 841.89, A4_600);
        assert_eq!(p.rotate, 0);
        assert!(p.w <= A4_600.printable_w && p.h <= A4_600.printable_h);
        // Fills one dimension fully
        assert!(p.w == A4_600.printable_w || p.h == A4_600.printable_h);
        // Kept inside the printable area
        assert!(p.x >= 0 && p.y >= 0 && p.x + p.w <= A4_600.printable_w && p.y + p.h <= A4_600.printable_h);
    }

    #[test]
    fn landscape_page_on_portrait_paper_is_turned() {
        let p = place(841.89, 595.28, A4_600);
        assert_eq!(p.rotate, 1);
        assert!(p.h > p.w, "the turned page is tall on the sheet");
    }

    #[test]
    fn a4_page_on_a3_paper_is_scaled_up() {
        let a3 = Device { printable_w: 6814, printable_h: 9720, paper_w: 7014, paper_h: 9920, offset_x: 100, offset_y: 100 };
        let p = place(595.28, 841.89, a3);
        assert!(p.w > 6000);
    }

    #[test]
    fn small_page_is_centred_on_the_sheet() {
        let p = place(100.0, 100.0, A4_600);
        assert_eq!(p.w, p.h);
        let centre_on_paper = p.y + A4_600.offset_y + p.h / 2;
        assert!((centre_on_paper - A4_600.paper_h / 2).abs() <= 1);
    }

    #[test]
    fn copies_use_the_driver_when_it_can_collate() {
        assert_eq!(plan_copies(3, 10, true, 999, true), Copies::Driver(3));
        assert_eq!(plan_copies(3, 1, false, 999, false), Copies::Driver(3));
        assert_eq!(plan_copies(1, 10, true, 0, false), Copies::Driver(1));
    }

    #[test]
    fn copies_are_repeated_when_the_driver_cannot() {
        assert_eq!(plan_copies(2, 3, true, 1, false), Copies::Repeat { n: 2, pad_blank: true });
        assert_eq!(plan_copies(2, 4, true, 1, false), Copies::Repeat { n: 2, pad_blank: false });
        assert_eq!(plan_copies(2, 3, false, 99, false), Copies::Repeat { n: 2, pad_blank: false });
    }

    #[test]
    fn repeated_copies_start_on_a_new_sheet_when_double_sided() {
        let seq = page_sequence(3, Copies::Repeat { n: 2, pad_blank: true });
        assert_eq!(seq, vec![Some(0), Some(1), Some(2), None, Some(0), Some(1), Some(2)]);
        assert_eq!(page_sequence(2, Copies::Driver(5)), vec![Some(0), Some(1)]);
    }
}
