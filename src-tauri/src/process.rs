use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Prevent background child processes from briefly opening a console window
/// when LevelUpAgent is running as a Windows GUI application.
pub fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

/// Same console suppression for short-lived synchronous helpers such as the
/// per-prompt router invocation.
pub fn hide_console_window_std(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}
