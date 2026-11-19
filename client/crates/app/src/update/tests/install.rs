//! Binary and bundle swaps in temp folders, with shell scripts standing in for printbetter.

use super::super::linux::{install, replace_binary};
use crate::test_util::{TempDir, script, tarball};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// An "installed" binary in its own folder.
fn installed(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("printbetter");
    script(&exe, "printbetter 0.1.0");
    exe
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn the_new_binary_replaces_the_old_one_with_mode_755() {
    let dir = TempDir::new();
    let exe = installed(dir.path());
    install(&tarball(dir.path(), Some("printbetter 9.9.9")), &exe, "9.9.9").unwrap();
    assert!(fs::read_to_string(&exe).unwrap().contains("printbetter 9.9.9"));
    assert_eq!(fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(listing(exe.parent().unwrap()), ["printbetter"], "no staged files left");
}

#[test]
fn a_binary_that_does_not_report_the_new_version_changes_nothing() {
    let dir = TempDir::new();
    let exe = installed(dir.path());
    let before = fs::read(&exe).unwrap();
    let err = install(&tarball(dir.path(), Some("printbetter 9.9.8")), &exe, "9.9.9").unwrap_err();
    assert!(err.contains("did not start correctly"), "{err}");
    assert_eq!(fs::read(&exe).unwrap(), before);
    assert_eq!(listing(exe.parent().unwrap()), ["printbetter"]);
}

#[test]
fn a_tarball_without_the_binary_changes_nothing() {
    let dir = TempDir::new();
    let exe = installed(dir.path());
    let before = fs::read(&exe).unwrap();
    assert!(install(&tarball(dir.path(), None), &exe, "9.9.9").is_err());
    let garbage = dir.path().join("garbage.tar.gz");
    fs::write(&garbage, "not gzip").unwrap();
    assert!(install(&garbage, &exe, "9.9.9").unwrap_err().contains("unpack"));
    assert_eq!(fs::read(&exe).unwrap(), before);
}

#[test]
fn replacing_into_a_missing_folder_fails_cleanly() {
    let dir = TempDir::new();
    let new = dir.path().join("new");
    script(&new, "printbetter 9.9.9");
    let err = replace_binary(&new, &dir.path().join("gone/printbetter"), "9.9.9").unwrap_err();
    assert!(err.contains("Can't write"), "{err}");
}

#[cfg(target_os = "macos")]
#[test]
fn app_bundles_swap_in_one_step() {
    let dir = TempDir::new();
    let (app, new) = (dir.path().join("Print Better.app"), dir.path().join("staging/Print Better.app"));
    for (bundle, marker) in [(&app, "old"), (&new, "new")] {
        fs::create_dir_all(bundle.join("Contents")).unwrap();
        fs::write(bundle.join("Contents/marker"), marker).unwrap();
    }
    super::super::macos::swap(&new, &app).unwrap();
    assert_eq!(fs::read_to_string(app.join("Contents/marker")).unwrap(), "new");
    assert_eq!(fs::read_to_string(new.join("Contents/marker")).unwrap(), "old");
    assert!(super::super::macos::swap(&dir.path().join("missing.app"), &app).is_err());
    assert_eq!(fs::read_to_string(app.join("Contents/marker")).unwrap(), "new");
}
