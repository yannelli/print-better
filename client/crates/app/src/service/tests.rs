//! Service definitions as `service install` writes them, rendered without installing anything.

use super::templates;
use std::path::Path;

const MAC_EXE: &str = "/Applications/Print Better & Co <beta>.app/Contents/MacOS/printbetter";
const MAC_EXE_XML: &str = "/Applications/Print Better &amp; Co &lt;beta&gt;.app/Contents/MacOS/printbetter";

fn rendered(text: &str) {
    assert!(!text.contains("{{") && !text.contains("}}") && !text.contains("EXTRA_ARGS"), "unfilled:\n{text}");
}

#[test]
fn launch_agent_runs_the_app_with_an_optional_no_tray() {
    let agent = templates::launch_agent(Path::new(MAC_EXE), false);
    rendered(&agent);
    assert!(agent.contains(&format!("<string>{MAC_EXE_XML}</string>\n\t\t<string>run</string>")));
    assert!(!agent.contains("--no-tray"));
    let headless = templates::launch_agent(Path::new(MAC_EXE), true);
    rendered(&headless);
    assert!(headless.contains("<string>run</string>\n\t\t<string>--no-tray</string>"));
}

#[test]
fn launch_daemon_and_tray_agent_split_the_work() {
    let daemon = templates::launch_daemon(Path::new(MAC_EXE));
    rendered(&daemon);
    assert!(daemon.contains("<string>dev.yannelli.printbetter</string>"));
    assert!(daemon.contains(&format!("<string>{MAC_EXE_XML}</string>\n\t\t<string>run</string>\n\t\t<string>--no-tray</string>")));
    let tray = templates::tray_agent(Path::new(MAC_EXE));
    rendered(&tray);
    assert!(tray.contains("<string>dev.yannelli.printbetter.tray</string>"));
    assert!(tray.contains("<string>tray-ui</string>") && tray.contains("<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>"));
}

#[cfg(target_os = "macos")]
#[test]
fn rendered_plists_pass_plutil_and_keep_the_exact_path() {
    use std::process::Command;
    let dir = crate::test_util::TempDir::new();
    let exe = Path::new(MAC_EXE);
    let plists = [
        ("agent", templates::launch_agent(exe, false), vec!["run"]),
        ("headless-agent", templates::launch_agent(exe, true), vec!["run", "--no-tray"]),
        ("daemon", templates::launch_daemon(exe), vec!["run", "--no-tray"]),
        ("tray", templates::tray_agent(exe), vec!["tray-ui"]),
    ];
    for (name, plist, args) in plists {
        let path = dir.path().join(format!("{name}.plist"));
        std::fs::write(&path, plist).unwrap();
        let lint = Command::new("plutil").arg("-lint").arg(&path).output().unwrap();
        assert!(lint.status.success(), "{name}: {}", String::from_utf8_lossy(&lint.stdout));
        let extract = |key: &str| {
            let out = Command::new("plutil").args(["-extract", key, "raw", "-o", "-"]).arg(&path).output().unwrap();
            String::from_utf8(out.stdout).unwrap().trim_end().to_string()
        };
        assert_eq!(extract("ProgramArguments.0"), MAC_EXE, "{name}");
        let rest: Vec<String> = (1..=args.len()).map(|i| extract(&format!("ProgramArguments.{i}"))).collect();
        assert_eq!(rest, args, "{name}");
    }
}

#[test]
fn user_unit_runs_the_binary_with_an_optional_no_tray() {
    let unit = templates::user_unit(Path::new("/usr/local/bin/printbetter"), false);
    rendered(&unit);
    assert!(unit.contains("\nExecStart=/usr/local/bin/printbetter run\n") && unit.contains("WantedBy=default.target"));
    let headless = templates::user_unit(Path::new("/usr/local/bin/printbetter"), true);
    assert!(headless.contains("\nExecStart=/usr/local/bin/printbetter run --no-tray\n"));
}

#[test]
fn unit_paths_are_quoted_and_specifiers_escaped() {
    let unit = templates::user_unit(Path::new("/opt/Print Better/print%better"), false);
    assert!(unit.contains("\nExecStart=\"/opt/Print Better/print%%better\" run\n"), "{unit}");
}

#[test]
fn system_unit_is_hardened_but_keeps_usb_devices_visible() {
    let unit = templates::system_unit(Path::new("/usr/local/bin/printbetter"));
    rendered(&unit);
    for line in [
        "ExecStart=/usr/local/bin/printbetter run --no-tray",
        "User=printbetter",
        "SupplementaryGroups=lp",
        "Environment=PRINTBETTER_SYSTEM=1",
        "ProtectSystem=strict",
        "DeviceAllow=char-usb_device rw",
        "WantedBy=multi-user.target",
    ] {
        assert!(unit.lines().any(|l| l == line), "missing {line}");
    }
    assert!(!unit.lines().any(|l| l.starts_with("PrivateDevices")), "PrivateDevices would hide /dev/bus/usb");
    assert!(templates::UDEV_RULE.contains("GROUP=\"lp\"") && templates::UDEV_RULE.contains("*:0701??:*"));
}

#[test]
fn the_update_helper_runs_as_root_when_the_daemon_drops_its_request() {
    let unit = templates::update_unit(Path::new("/usr/local/bin/printbetter"));
    rendered(&unit);
    for line in ["Type=oneshot", "ExecStart=/usr/local/bin/printbetter update-helper", "StateDirectory=printbetter-update"] {
        assert!(unit.lines().any(|l| l == line), "missing {line}");
    }
    assert!(!unit.lines().any(|l| l.starts_with("User=")), "the helper must run as root");
    let trigger = templates::UPDATE_TRIGGER;
    assert!(trigger.lines().any(|l| l == format!("PathExists={}", crate::update::helper::REQUEST)), "{trigger}");
    assert!(trigger.lines().any(|l| l == "Unit=printbetter-update.service"));
    let daemon = templates::system_unit(Path::new("/usr/local/bin/printbetter"));
    assert!(daemon.lines().any(|l| l == "StateDirectory=printbetter"), "the request lives in the daemon's own folder");
}

#[test]
fn scheduled_task_runs_as_system_without_the_tray() {
    let task = templates::scheduled_task(Path::new(r"C:\Program Files\Print Better & Co\printbetter.exe"));
    rendered(&task);
    assert!(task.contains(r"<Command>C:\Program Files\Print Better &amp; Co\printbetter.exe</Command>"));
    assert!(task.contains("<Arguments>run --no-tray</Arguments>") && task.contains("<UserId>S-1-5-18</UserId>"));
    assert!(task.contains("<BootTrigger>") && task.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"));
}
