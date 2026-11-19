use pb_print::PrinterReport;
use std::collections::HashSet;

/// Picks the printer for `print`: exact key or name, then a unique partial name; with no
/// hint, the only added printer, else the only printer at all.
pub fn printer<'a>(
    printers: &'a [PrinterReport],
    added: &HashSet<String>,
    hint: Option<&str>,
) -> Result<&'a PrinterReport, String> {
    if let Some(hint) = hint.map(str::trim).filter(|h| !h.is_empty()) {
        let wanted = hint.to_lowercase();
        if let Some(exact) = printers.iter().find(|p| p.key == hint || p.name.to_lowercase() == wanted) {
            return Ok(exact);
        }
        let partial: Vec<&PrinterReport> = printers.iter().filter(|p| p.name.to_lowercase().contains(&wanted)).collect();
        return match partial.as_slice() {
            [one] => Ok(one),
            [] => Err(format!("No printer matches \"{hint}\". {}", names(printers.iter()))),
            many => Err(format!("\"{hint}\" matches several printers. {}", names(many.iter().copied()))),
        };
    }
    let added_ones: Vec<&PrinterReport> = printers.iter().filter(|p| added.contains(&p.key)).collect();
    let pool = if added_ones.is_empty() { printers.iter().collect() } else { added_ones };
    match pool.as_slice() {
        [one] => Ok(one),
        [] => Err("No printers found. Check that the printer is on and connected.".into()),
        many => Err(format!("Several printers found; choose one with --printer. {}", names(many.iter().copied()))),
    }
}

fn names<'a>(printers: impl Iterator<Item = &'a PrinterReport>) -> String {
    let list: Vec<String> = printers.map(|p| format!("\"{}\"", p.name)).collect();
    if list.is_empty() { "No printers were found.".into() } else { format!("Printers: {}", list.join(", ")) }
}
