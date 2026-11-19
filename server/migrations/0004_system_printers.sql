-- What a desktop last reported about its remote printers and default printer (docs/remote-printers.md).
ALTER TABLE clients ADD COLUMN system_printers TEXT;
