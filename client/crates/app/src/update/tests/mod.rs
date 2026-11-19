mod fetch;
#[cfg(unix)]
mod helper;
#[cfg(unix)]
mod install;

use super::macos::{pkg_team, same_team, team_from_codesign};
use super::{Plan, Target, Version, plan};
use std::path::{Path, PathBuf};

fn v(text: &str) -> Version {
    Version::parse(text).unwrap_or_else(|| panic!("{text} should parse"))
}

#[test]
fn versions_follow_semver_order() {
    let ordered = ["0.1.0", "0.1.1", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta.2", "0.2.0-beta.11", "0.2.0-rc.1", "0.2.0", "0.10.0", "1.0.0"];
    for pair in ordered.windows(2) {
        assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
    }
    assert_eq!(v("v1.2.3+build.5"), v("1.2.3"));
    for bad in ["", "1.2", "1.2.3.4", "1.x.3", "1.2.3-", "1.2.3-a..b", "1.2.-3"] {
        assert_eq!(Version::parse(bad), None, "{bad}");
    }
}

#[test]
fn plan_never_downgrades_and_respects_auto_update_and_dev_builds() {
    assert_eq!(plan("0.2.0", "0.3.0", false, true, false), Ok(Plan::Install));
    assert_eq!(plan("0.3.0", "0.3.0", true, true, false), Ok(Plan::UpToDate));
    assert_eq!(plan("0.4.0", "0.3.0", true, true, false), Ok(Plan::UpToDate), "never downgrade, even when asked");
    assert_eq!(plan("0.3.0-rc.1", "0.3.0", false, true, false), Ok(Plan::Install));
    assert!(matches!(plan("0.2.0", "0.3.0", false, false, false), Ok(Plan::Hold(_))));
    assert!(matches!(plan("0.2.0", "0.3.0", false, true, true), Ok(Plan::Hold(_))));
    assert_eq!(plan("0.2.0", "0.3.0", true, false, true), Ok(Plan::Install), "asking overrides both");
    assert!(plan("0.2.0", "latest", true, true, false).is_err());
}

#[test]
fn the_install_kind_follows_where_the_binary_lives() {
    let exe = |p: &str| PathBuf::from(p);
    let bin = exe("/usr/local/bin/printbetter");
    assert_eq!(Target::for_exe(&bin, "linux", true), Ok(Target::Binary(bin.clone())));
    let system = exe("/Applications/Print Better.app/Contents/MacOS/printbetter");
    assert_eq!(Target::for_exe(&system, "macos", true), Ok(Target::Pkg(exe("/Applications/Print Better.app"))));
    let user = exe("/Users/sam/Applications/Print Better.app/Contents/MacOS/printbetter");
    assert_eq!(Target::for_exe(&user, "macos", false), Ok(Target::App(exe("/Users/sam/Applications/Print Better.app"))));
    assert!(Target::for_exe(&user, "macos", true).unwrap_err().contains("without sudo"));
    assert!(Target::for_exe(&exe("/Users/sam/code/target/release/printbetter"), "macos", false).is_err());
    assert!(Target::for_exe(&exe(r"C:\Users\sam\printbetter.exe"), "windows", false).unwrap_err().contains("Windows"));
}

#[test]
fn the_latest_query_names_the_artifact_kind() {
    let app = Target::App(PathBuf::from("/Users/sam/Applications/Print Better.app"));
    assert!(app.latest_path().starts_with("/api/client/latest?os=") && app.latest_path().ends_with("&kind=app"));
    assert!(Target::Pkg(PathBuf::from("/Applications/Print Better.app")).latest_path().ends_with("&kind=pkg"));
    assert!(!Target::Binary(PathBuf::from("/usr/local/bin/printbetter")).latest_path().contains("kind="));
}

#[test]
fn cargo_output_counts_as_a_development_build() {
    assert!(Target::Binary(PathBuf::from("/home/sam/print-better/client/target/t-update/release/printbetter")).is_dev_build());
    // Test binaries are debug builds, so an installed path still reads as development here.
    assert_eq!(Target::Binary(PathBuf::from("/usr/local/bin/printbetter")).is_dev_build(), cfg!(debug_assertions));
}

#[test]
fn installable_checks_the_folder_can_be_written() {
    let dir = crate::test_util::TempDir::new();
    let exe = dir.path().join("printbetter");
    assert_eq!(super::installable(&Target::Binary(exe.clone())), Ok(()));
    let missing = Path::new("/nonexistent-printbetter-dir/printbetter");
    let refused = super::installable(&Target::Binary(missing.into())).unwrap_err();
    assert!(refused.contains("sudo printbetter update"), "{refused}");
}

const CODESIGN: &str = "Executable=/Applications/Print Better.app/Contents/MacOS/printbetter
Identifier=dev.yannelli.printbetter
Authority=Developer ID Application: Example Developer (ABCDE12345)
TeamIdentifier=ABCDE12345
Runtime Version=27.0.0";

const PKGUTIL: &str = r#"Package "PrintBetter-0.1.0.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Certificate Chain:
    1. Developer ID Installer: Example Developer (ABCDE12345)
       Expires: 2027-02-01 22:12:15 +0000
    2. Developer ID Certification Authority
    3. Apple Root CA"#;

#[test]
fn team_ids_come_from_codesign_and_pkgutil() {
    assert_eq!(team_from_codesign(CODESIGN).as_deref(), Some("ABCDE12345"));
    assert_eq!(team_from_codesign("Signature=adhoc\nTeamIdentifier=not set"), None);
    assert_eq!(team_from_codesign("code object is not signed at all"), None);
    assert_eq!(pkg_team(PKGUTIL), Ok("ABCDE12345".into()));
}

#[test]
fn packages_without_a_developer_id_installer_signature_are_refused() {
    assert!(pkg_team("Package \"x.pkg\":\n   Status: no signature").unwrap_err().contains("no signature"));
    let untrusted = PKGUTIL.replace("signed by a developer certificate issued by Apple for distribution", "signed by untrusted certificate");
    assert!(pkg_team(&untrusted).is_err());
    let app_cert = PKGUTIL.replace("1. Developer ID Installer:", "1. Developer ID Application:");
    assert!(pkg_team(&app_cert).unwrap_err().contains("Installer"));
    assert!(same_team("ABCDE12345", "ABCDE12345").is_ok());
    assert!(same_team("ABCDE12345", "ZYXWV98765").unwrap_err().contains("ZYXWV98765"));
}
