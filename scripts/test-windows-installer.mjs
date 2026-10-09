import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const template = readFileSync(join(root, "src-tauri", config.bundle.windows.nsis.template), "utf8");
const functionBody = (name) => {
  const match = template.match(new RegExp(`^Function ${name}\\r?\\n([\\s\\S]*?)^FunctionEnd`, "m"));
  assert.ok(match, `Missing production function ${name}`);
  return match[1];
};

test("Windows upgrade uses the versioned custom NSIS template", () => {
  assert.equal(config.bundle.windows.nsis.template, "windows/installer.nsi");
  assert.equal(config.bundle.publisher, "TippingGame");
  // Review the upstream template when changing the CLI, before shipping it.
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /'@tauri-apps\/cli':\s+specifier: [^\n]+\s+version: 2\.11\.4\s/);
});

test("NSIS follows system language and requires confirmation before deleting personal data", () => {
  assert.deepEqual(config.bundle.windows.nsis.languages, ["English", "SimpChinese", "TradChinese"]);
  assert.equal(config.bundle.windows.nsis.displayLanguageSelector, false);
  assert.match(functionBody(".onInit"), /!insertmacro UseSystemLanguage/);
  assert.match(functionBody("un.onInit"), /!insertmacro UseSystemLanguage/);
  assert.doesNotMatch(functionBody("un.onInit"), /!insertmacro MUI_UNGETLANGUAGE/);
  assert.match(template, /kernel32::GetUserDefaultUILanguage/);
  assert.match(template, /LangString confirmDeleteAppData \$\{LANG_SIMPCHINESE\}/);
  assert.match(template, /LangString confirmDeleteAppData \$\{LANG_TRADCHINESE\}/);
  assert.match(functionBody("un.ConfirmShow"), /\$\{NSD_OnClick\} \$DeleteAppDataCheckbox un\.ConfirmDeleteAppData/);
  assert.match(functionBody("un.ConfirmDeleteAppData"), /MB_YESNO\|MB_ICONEXCLAMATION\|MB_DEFBUTTON2/);
  assert.match(functionBody("un.ConfirmDeleteAppData"), /\$\{NSD_SetState\} \$DeleteAppDataCheckbox \$\{BST_UNCHECKED\}/);
  assert.match(functionBody("un.ConfirmDeleteAppData"), /\$\{NSD_SetState\} \$DeleteAppDataCheckbox \$\{BST_CHECKED\}/);
  assert.match(functionBody("un.ConfirmLeave"), /\$DeleteAppDataConfirmed != 1[\s\S]*StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.match(template, /\$DeleteAppDataCheckboxState = 1\s+\$\{AndIf\} \$DeleteAppDataConfirmed = 1\s+\$\{AndIf\} \$UpdateMode <> 1/);
});

test("native NSIS resolves and uninstalls legacy/current installs without deleting user data", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, () => {
  const compiler = [
    process.env.MAKENSIS,
    join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe"),
    "C:/Program Files (x86)/NSIS/makensis.exe",
    "C:/Program Files/NSIS/makensis.exe",
  ].find((path) => path && existsSync(path));
  assert.ok(compiler, "NSIS compiler required on Windows; set MAKENSIS to makensis.exe");
  const id = `LevelUpAgentInstallerTest-${randomUUID()}`;
  const output = join(root, "artifacts", id);
  mkdirSync(output, { recursive: true });
  const quote = (value) => value.replaceAll("$", "$$").replaceAll('"', '$\\"');
  const nativeOutput = quote(output.replaceAll("/", "\\"));
  const uninstall = functionBody("PageLeaveReinstall").match(/  reinst_uninstall:([\s\S]*?)  reinst_done:/);
  assert.ok(uninstall);
  const languageMacros = template.match(/!macro NormalizeSystemLanguage[\s\S]*?!macro UseSystemLanguage[\s\S]*?!macroend/)[0];
  const languageChecks = [[2052,2052],[4100,2052],[1028,1028],[3076,1028],[5124,1028],[1033,1033],[1031,1033]].map(([input, expected]) =>
    `StrCpy $LANGUAGE ${input}\n!insertmacro NormalizeSystemLanguage\n!insertmacro AssertEqual '$LANGUAGE' '${expected}' 'display language ${input} selects ${expected}'`).join("\n");
  // Compile the actual production functions and uninstall branch. Only the
  // registry namespace, payload, and uninstaller belong to this test fixture.
  const source = String.raw`
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
Name "${id}"
OutFile "${nativeOutput}\test.exe"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!define PRODUCTNAME "${id}"
!define MANUPRODUCTKEY "Software\LevelUpAgent Installer Tests\@{PRODUCTNAME}\Current"
!define UNINSTKEY "Software\LevelUpAgent Installer Tests\@{PRODUCTNAME}\Uninstall"
!define MAINBINARYNAME "fixture"
!define TESTROOT "${nativeOutput}"
Var PreviousInstallDir
Var WixMode
Var UpdateMode
Var PassiveMode
Var Log
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
Var DeleteAppDataConfirmed
LangString unableToUninstall 1033 "Unable to uninstall!"
LangString confirmDeleteAppData 1033 "Delete test data?"
${languageMacros}

!macro AssertEqual actual expected label
  StrCmp '@{actual}' '@{expected}' +4
    FileWrite $Log 'FAIL: @{label}: @{actual} != @{expected}$\r$\n'
    SetErrorLevel 9
    Quit
  FileWrite $Log 'PASS: @{label}$\r$\n'
!macroend
!macro RegisterFixture directory
  StrCpy $INSTDIR '@{directory}'
  CreateDirectory $INSTDIR
  FileOpen $0 '$INSTDIR\fixture.exe' w
  FileWrite $0 "fixture"
  FileClose $0
  FileOpen $0 '$INSTDIR\user-data.keep' w
  FileWrite $0 "conversation sentinel"
  FileClose $0
  WriteUninstaller '$INSTDIR\uninstall.exe'
  WriteRegStr HKCU '@{UNINSTKEY}' 'UninstallString' '$\"$INSTDIR\uninstall.exe$\"'
!macroend
!macro AssertPreserved directory label
  IfFileExists '@{directory}\user-data.keep' +4
    FileWrite $Log 'FAIL: @{label}: user data removed$\r$\n'
    SetErrorLevel 9
    Quit
  FileWrite $Log 'PASS: @{label}$\r$\n'
!macroend

Function GetPreviousUninstallDirectory
${functionBody("GetPreviousUninstallDirectory")}
FunctionEnd
Function RestorePreviousInstallLocation
${functionBody("RestorePreviousInstallLocation")}
FunctionEnd
Function RunPreviousUninstall
${uninstall[1]}
  reinst_done:
FunctionEnd

Function un.ConfirmDeleteAppData
${functionBody("un.ConfirmDeleteAppData")}
FunctionEnd
Function un.ConfirmLeave
${functionBody("un.ConfirmLeave")}
FunctionEnd

Function un.onInit
  @{GetOptions} $CMDLINE "/CLEANUPTEST" $0
  IfErrors cleanup_test_done
  FileOpen $Log '@{TESTROOT}\cleanup-results.txt' w
${languageChecks}
  !insertmacro UseSystemLanguage
  ; A hidden, fixture-only checkbox exercises production state transitions.
  ; /S also verifies MessageBox /SD IDNO without interacting with the desktop.
  System::Call 'user32::CreateWindowExW(i0, w "BUTTON", w "", i @{BS_AUTOCHECKBOX}, i0, i0, i100, i20, p0, p0, p0, p0) p.s'
  Pop $DeleteAppDataCheckbox
  IntCmp $DeleteAppDataCheckbox 0 cleanup_test_no_control
  StrCpy $DeleteAppDataConfirmed 0
  Call un.ConfirmLeave
  !insertmacro AssertEqual '$DeleteAppDataCheckboxState' '0' 'cleanup is off by default'
  @{NSD_SetState} $DeleteAppDataCheckbox @{BST_CHECKED}
  Call un.ConfirmLeave
  !insertmacro AssertEqual '$DeleteAppDataCheckboxState' '0' 'checked box without confirmation cannot enable cleanup'
  StrCpy $DeleteAppDataConfirmed 1
  Call un.ConfirmLeave
  !insertmacro AssertEqual '$DeleteAppDataCheckboxState' '1' 'confirmed checked box enables cleanup'
  @{NSD_SetState} $DeleteAppDataCheckbox @{BST_UNCHECKED}
  Push $DeleteAppDataCheckbox
  Call un.ConfirmDeleteAppData
  !insertmacro AssertEqual '$DeleteAppDataConfirmed' '0' 'unchecking revokes confirmation'
  Call un.ConfirmLeave
  !insertmacro AssertEqual '$DeleteAppDataCheckboxState' '0' 'unchecking preserves data'
  @{NSD_SetState} $DeleteAppDataCheckbox @{BST_CHECKED}
  Push $DeleteAppDataCheckbox
  Call un.ConfirmDeleteAppData
  @{NSD_GetState} $DeleteAppDataCheckbox $0
  !insertmacro AssertEqual '$0' '0' 'No leaves checkbox unchecked'
  !insertmacro AssertEqual '$DeleteAppDataConfirmed' '0' 'No cannot authorize cleanup'
  Call un.ConfirmLeave
  !insertmacro AssertEqual '$DeleteAppDataCheckboxState' '0' 'No preserves data on page leave'
  System::Call 'user32::DestroyWindow(p $DeleteAppDataCheckbox)'
  FileWrite $Log 'COMPLETE$\r$\n'
  FileClose $Log
  SetErrorLevel 0
  Quit
  cleanup_test_no_control:
    FileWrite $Log 'FAIL: could not create fixture checkbox$\r$\n'
    FileClose $Log
    SetErrorLevel 9
    Quit
  cleanup_test_done:
FunctionEnd

Section
  SetShellVarContext current
  SetRegView 64
  StrCpy $PassiveMode 1
  FileOpen $Log '@{TESTROOT}\results.txt' w
${languageChecks}
  !insertmacro UseSystemLanguage
  WriteUninstaller '@{TESTROOT}\cleanup-test.exe'
  ExecWait '$\"@{TESTROOT}\cleanup-test.exe$\" /S /CLEANUPTEST _?=@{TESTROOT}' $0
  !insertmacro AssertEqual '$0' '0' 'production cleanup state transitions pass'
  !insertmacro RegisterFixture '@{TESTROOT}\旧版 自定义目录'
  WriteRegStr HKCU 'Software\levelup\@{PRODUCTNAME}' '' '$INSTDIR'
  WriteRegStr HKCU '@{UNINSTKEY}' 'DisplayVersion' '1.0.51'
  ; Reproduce the exact old failure without invoking any production executable.
  ExecWait '$\"$INSTDIR\uninstall.exe$\" /S _?=' $0
  !insertmacro AssertEqual '$0' '2' 'empty _?= reproduces the 1.0.63 failure'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '$INSTDIR' 'legacy publisher, stale DisplayVersion, spaces and Unicode'
  StrCpy $INSTDIR '@{TESTROOT}\new default'
  Call RestorePreviousInstallLocation
  !insertmacro AssertEqual '$INSTDIR' '@{TESTROOT}\旧版 自定义目录' 'restore legacy custom directory'
  ; An explicit new destination must not be mistaken for the old directory.
  StrCpy $INSTDIR '@{TESTROOT}\new destination'
  Call RunPreviousUninstall
  !insertmacro AssertEqual '$0' '0' 'uninstall-before-install succeeds for legacy publisher'
  !insertmacro AssertPreserved '@{TESTROOT}\旧版 自定义目录' 'legacy user data preserved'

  !insertmacro RegisterFixture '@{TESTROOT}\current 1.0.63'
  WriteRegStr HKCU '@{MANUPRODUCTKEY}' '' '@{TESTROOT}\stale publisher directory'
  WriteRegStr HKCU '@{UNINSTKEY}' 'InstallLocation' '$\"@{TESTROOT}\stale location$\"'
  Call RestorePreviousInstallLocation
  !insertmacro AssertEqual '$INSTDIR' '@{TESTROOT}\current 1.0.63' 'uninstaller takes priority over stale directory records'
  Call RunPreviousUninstall
  !insertmacro AssertEqual '$0' '0' 'uninstall-before-install succeeds for current publisher'
  !insertmacro AssertPreserved '@{TESTROOT}\current 1.0.63' 'current user data preserved'

  !insertmacro RegisterFixture '@{TESTROOT}\updater location'
  StrCpy $INSTDIR '@{TESTROOT}\default'
  Call RestorePreviousInstallLocation
  !insertmacro AssertEqual '$INSTDIR' '@{TESTROOT}\updater location' 'silent/updater initialization restores existing directory'
  !insertmacro AssertPreserved '@{TESTROOT}\updater location' 'overlay path does not invoke uninstaller'
  WriteRegStr HKCU '@{UNINSTKEY}' 'UninstallString' '@{TESTROOT}\updater location\uninstall.exe'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '$INSTDIR' 'unquoted registered executable is supported'

  WriteRegStr HKCU '@{UNINSTKEY}' 'UninstallString' '$\"$INSTDIR\uninstall.exe$\" /unexpected'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '' 'argument-bearing command is rejected'
  WriteRegStr HKCU '@{UNINSTKEY}' 'UninstallString' '$\"$INSTDIR\uninstall.exe'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '' 'unbalanced quotes are rejected'
  WriteRegStr HKCU '@{UNINSTKEY}' 'UninstallString' '$\"@{TESTROOT}\missing\uninstall.exe$\"'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '' 'missing uninstaller is rejected'
  WriteRegStr HKCU '@{UNINSTKEY}' 'UninstallString' '$\"$INSTDIR\fixture.exe$\"'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '' 'unexpected executable is rejected'
  DeleteRegKey HKCU '@{UNINSTKEY}'
  Call GetPreviousUninstallDirectory
  !insertmacro AssertEqual '$4' '' 'fresh installation has no uninstall directory'
  DeleteRegKey HKCU '@{MANUPRODUCTKEY}'
  Call RestorePreviousInstallLocation
  !insertmacro AssertEqual '$INSTDIR' '@{TESTROOT}\旧版 自定义目录' 'remember legacy directory after uninstall'
  DeleteRegKey HKCU 'Software\levelup\@{PRODUCTNAME}'
  StrCpy $INSTDIR '@{TESTROOT}\fresh default'
  Call RestorePreviousInstallLocation
  !insertmacro AssertEqual '$INSTDIR' '@{TESTROOT}\fresh default' 'fresh installation retains default directory'
  DeleteRegKey HKCU 'Software\LevelUpAgent Installer Tests\@{PRODUCTNAME}'
  FileWrite $Log 'COMPLETE$\r$\n'
  FileClose $Log
SectionEnd

Section Uninstall
  SetRegView 64
  Delete '$INSTDIR\fixture.exe'
  DeleteRegKey HKCU '@{UNINSTKEY}'
SectionEnd
`.replaceAll("@{", "$" + "{");
  // Expand NSIS macro placeholders after JavaScript interpolation.
  const script = join(output, "test.nsi");
  writeFileSync(script, "\ufeff" + source, "utf8");
  const compile = spawnSync(compiler, ["/V2", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(join(output, "test.exe"), ["/S"], { windowsHide: true, timeout: 60_000 });
  const result = readFileSync(join(output, "results.txt"), "utf8");
  assert.equal(run.status, 0, `${run.error ?? ""}\n${result}`);
  assert.match(result, /COMPLETE/);
  assert.doesNotMatch(result, /FAIL:/);
  const cleanupResult = readFileSync(join(output, "cleanup-results.txt"), "utf8");
  assert.match(cleanupResult, /COMPLETE/);
  assert.doesNotMatch(cleanupResult, /FAIL:/);
  console.log(result.trim());
  console.log(cleanupResult.trim());
  console.log(`Native installer evidence: ${output}`);
});
