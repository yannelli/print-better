use super::TestDir;
use crate::convert::spool::{Out, TempFile, sweep};
use std::fs::{self, File};
use std::time::{Duration, SystemTime};

#[test]
fn temp_files_live_under_state_dir_and_vanish_on_drop() {
    let dir = TestDir::new("tempfile");
    let (temp, _file) = TempFile::create(&dir.0, "pwg").expect("create");
    let path = temp.path().to_path_buf();
    assert!(path.starts_with(dir.0.join("convert")) && path.extension().is_some_and(|e| e == "pwg"));
    assert!(path.exists());
    let (other, _) = TempFile::create(&dir.0, "pwg").expect("second");
    assert_ne!(other.path(), path, "names never collide");
    drop(temp);
    assert!(!path.exists());
}

#[test]
fn sweep_removes_only_day_old_scratch_files() {
    let dir = TestDir::new("sweep");
    let scratch = dir.0.join("convert");
    fs::create_dir_all(&scratch).expect("dir");
    let old = scratch.join("pb-1-1.pdf");
    let fresh = scratch.join("pb-1-2.pdf");
    for path in [&old, &fresh] {
        fs::write(path, b"x").expect("write");
    }
    let day_ago = SystemTime::now() - Duration::from_secs(25 * 3600);
    File::options().write(true).open(&old).expect("open").set_modified(day_ago).expect("age it");
    sweep(&dir.0);
    assert!(!old.exists() && fresh.exists());
    sweep(&dir.0.join("missing"));
}

#[test]
fn out_repeats_and_patches_written_bytes() {
    let dir = TestDir::new("out");
    let path = dir.0.join("out");
    let mut out = Out::new(File::create(&path).expect("create"), &path);
    out.write(b"HEAD0000").expect("write");
    let start = out.pos();
    out.write(b"[page]").expect("write");
    let end = out.pos();
    out.repeat(start, end, 2).expect("repeat");
    out.repeat(start, end, 0).expect("no-op");
    out.patch(4, b"0003").expect("patch");
    out.write(b"END").expect("write after patch");
    assert_eq!(out.pos(), 29);
    out.finish().expect("finish");
    assert_eq!(fs::read(&path).expect("read"), b"HEAD0003[page][page][page]END");
}
