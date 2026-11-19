//! IEEE 1284 Device ID strings (`MFG:HP;MDL:LaserJet;CMD:PCL,POSTSCRIPT;SN:X;`), as read over
//! USB GET_DEVICE_ID or SNMP. Shared by USB enumeration and SNMP discovery.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceId {
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    /// Raw command-set tokens, uppercased.
    pub commands: Vec<String>,
    pub serial: Option<String>,
    pub description: Option<String>,
}

impl DeviceId {
    pub fn parse(raw: &str) -> DeviceId {
        let mut id = DeviceId::default();
        for field in raw.split(';') {
            let Some((key, value)) = field.split_once(':') else { continue };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match key.trim().to_ascii_uppercase().as_str() {
                "MFG" | "MANUFACTURER" => id.manufacturer = Some(value.to_string()),
                "MDL" | "MODEL" => id.model = Some(value.to_string()),
                "CMD" | "COMMAND SET" => {
                    id.commands = value.split(',').map(|c| c.trim().to_ascii_uppercase()).collect()
                }
                "SN" | "SERN" | "SERIALNUMBER" => id.serial = Some(value.to_string()),
                "DES" | "DESCRIPTION" => id.description = Some(value.to_string()),
                _ => {}
            }
        }
        id
    }

    /// "HP LaserJet Pro M404-M405", avoiding a doubled manufacturer prefix.
    pub fn make_model(&self) -> Option<String> {
        match (&self.manufacturer, &self.model) {
            (Some(m), Some(d)) if d.to_ascii_lowercase().starts_with(&m.to_ascii_lowercase()) => Some(d.clone()),
            (Some(m), Some(d)) => Some(format!("{m} {d}")),
            (None, Some(d)) => Some(d.clone()),
            (Some(m), None) => Some(m.clone()),
            (None, None) => self.description.clone(),
        }
    }

    /// MIME types implied by the command set, most capable first.
    pub fn formats(&self) -> Vec<String> {
        let mut out: Vec<&str> = Vec::new();
        for cmd in &self.commands {
            let mime = match cmd.as_str() {
                "PDF" => "application/pdf",
                "POSTSCRIPT" | "PS" | "BRSCRIPT" | "PS3" => "application/postscript",
                "PCLXL" | "PCL XL" | "PCL6" => "application/vnd.hp-PCLXL",
                "PCL" | "PCL5" | "PCL5C" | "PCL5E" | "PCL3" | "PCL3GUI" => "application/vnd.hp-PCL",
                "URF" | "APPLERASTER" => "image/urf",
                "PWGRASTER" | "PWG" => "image/pwg-raster",
                "PCLM" => "application/PCLm",
                "JPEG" | "JPG" => "image/jpeg",
                _ => continue,
            };
            if !out.contains(&mime) {
                out.push(mime);
            }
        }
        out.into_iter().map(String::from).collect()
    }
}
