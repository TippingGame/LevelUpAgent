# Windows installer compatibility

## Publisher rename regression

Version 1.0.63 changed `bundle.publisher` from `levelup` to `TippingGame`.
The upstream Tauri NSIS template discovers an existing uninstall entry by product
name, but reads its directory from `Software\<publisher>\<product>`. An old
installation therefore remains discoverable while its directory lookup fails.
Choosing **Uninstall before installing** produces `uninstall.exe _?=` with no
directory. NSIS rejects the command during initialization and exits with code 2.

The registered DisplayVersion can lag behind the installed executable; this is
not the cause of the empty directory and is not used to resolve the path.

## Fix in 1.0.64

`src-tauri/windows/installer.nsi` is based on the official
[tauri-cli-v2.11.4 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi),
under Tauri's MIT / Apache-2.0 licenses. The configuration explicitly selects it.
The installation-directory changes are:

- Derive the directory from the existing product's registered `UninstallString`,
  which does not depend on publisher metadata. Strip paired outer quotes and
  require an existing `uninstall.exe` with an absolute, non-root parent directory.
- Reject missing or malformed commands before launching the old uninstaller.
  Never append an empty `_?=`. Preserve the required NSIS convention of leaving
  this final directory argument unquoted, including paths containing spaces.
- Restore this same directory for interactive, passive, and silent initialization,
  including updater mode. Keep current/legacy publisher keys as remembered-location
  fallbacks when no registered uninstaller is available.
- After uninstalling, check the previous directory for the old executable, even
  when `/D=` explicitly selects a different new installation directory.
- Clear lookup errors before `ExecWait`; a missing optional registry value must
  not be misreported as a process creation failure.

No migration writes run merely by opening the installer. Normal installation
writes the current publisher, version, and directory records as before. The
updater, MSI path, and signing configuration retain their upstream behavior.
This change does not migrate between MSI and NSIS.

## Language and personal-data confirmation

The NSIS package includes English, Simplified Chinese, and Traditional Chinese.
Both initializers call `GetUserDefaultUILanguage` on every launch. Mainland China
and Singapore select Simplified Chinese; Taiwan, Hong Kong and Macao select
Traditional Chinese; other languages fall back to English. Neither installation
nor uninstallation opens a language picker or restores an old installer language.
Changing the Windows display language after installation also changes uninstall UI.

The uninstall confirmation page uses `nsDialogs`, so both mouse and keyboard
checkbox changes reach the same callback. Personal data is kept by default.
Selecting cleanup first opens a localized warning with **No** as the default;
only **Yes** checks the box. Unchecking clears the confirmation, and selecting
again requires a fresh confirmation. Leaving the page requires both a checked
box and the explicit confirmation before enabling cleanup. Silent/passive
uninstalls keep data, and the existing updater-mode deletion guard remains.
The cleanup paths remain the existing per-account AppData directories; clicking
the checkbox or opening the warning does not delete anything.

The standard installer hooks execute after the maintenance page; a pre-install
hook alone cannot repair this failure. That is why a versioned template is used.

## Regression validation

Run `node --test scripts/test-windows-installer.mjs`, also included in `pnpm check`.
On Windows the test requires NSIS (`MAKENSIS` can override its location). It compiles
the actual production resolver, restoration function, and uninstall branch into
an isolated native test fixture. All registry keys and files use a unique test
product; production LevelUpAgent installs and user data are never test targets.

The fixture reproduces exit code 2 using the previous empty-parameter command,
then verifies successful old/new publisher uninstalls, custom Unicode and spaced
paths, stale version/directory records, preserved user-data sentinels, missing or
malformed uninstall commands, remembered paths, and fresh installs. It also runs
the production cleanup callbacks against a hidden fixture checkbox, covering
unchecked defaults, unconfirmed selection, confirmed selection, revocation,
and the safe **No** response in silent mode. No production cleanup runs. Artifacts and
assertion output remain under `artifacts/LevelUpAgentInstallerTest-*`.

When updating the Tauri CLI, review the vendored template against the new upstream
template, retain these changes, update the pinned-version assertion, and rerun
both the native regression and full installer upgrade checks before release.
Never replace a published signed release in place; increment the patch version.
