//! One Chrome per profile: an advisory file lock on the profile dir, honored across the
//! web-server process (assist) and the run subprocess (auto).

use anyhow::Result;
use fs2::FileExt;
use std::fs::File;

#[allow(dead_code)]
pub struct ProfileLock {
    _file: File,
}

/// Try to acquire the profile lock without blocking. Returns None if another process holds it.
#[allow(dead_code)]
pub fn try_acquire() -> Result<Option<ProfileLock>> {
    let path = crate::linkedin::profile_dir()?.join(".lock");
    let file = File::create(path)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(ProfileLock { _file: file })),
        Err(_) => Ok(None),
    }
}

// Lock releases when the File is dropped (fs2 unlocks on close).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_is_busy_while_held() {
        crate::testutil::with_home("ct-li-lock", |_| {
            let first = try_acquire().unwrap();
            assert!(first.is_some());
            let second = try_acquire().unwrap();
            assert!(second.is_none(), "lock should be busy while held");
            drop(first);
            assert!(try_acquire().unwrap().is_some(), "released after drop");
        });
    }
}
