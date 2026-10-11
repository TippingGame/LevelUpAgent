# Audio resource release

Audio resources are independent of app installers. `resources.json` pins resource version `2026.10.1`, target `windows-x64-cu128`, model revision, repository and shared Release tag. Never overwrite published assets; change the resource version for different bytes.

## Prepare

Use a Windows x64 Python 3.10.11 base and the validated isolated MusicGen environment. `requirements.lock.txt` records inference dependencies; PyTorch is separately pinned to `2.8.0+cu128`. Do not point this at a system environment with unrelated packages.

```powershell
python scripts/prepare-music-runtime.py --base-python C:\build\Python310 --venv C:\build\musicgen --output C:\build\audio-staging\runtime
```

This copies the interpreter, DLLs, standard library and isolated site-packages, removes venv path dependence and Python path injection, retains distribution license metadata, and probes sqlite3/SSL/PyTorch/Transformers imports. It is a release-builder operation; end users never run pip. Runtime DLLs come from the official PyTorch distribution; do not redistribute a full CUDA toolkit or driver.

Place the verified `facebook/musicgen-small` snapshot under `audio-staging/musicgen-small/`, including its `manifest.json`, tokenizer/config files, weights and README/model card. Add `provenance.json` containing `license: "CC-BY-NC-4.0"` and the pinned Hugging Face source URL in `sources`. The packager checks every model record against its SHA256 before compression.

## Package and verify

```powershell
python scripts/package-music-workbench.py --staging C:\build\audio-staging --output artifacts/music-workbench/release
```

The two ZIP archives are split into assets of at most 1,000,000,000 bytes, below GitHub's asset limit. The manifest contains whole-archive and per-part SHA256, exact unpacked size and provenance. Archive members must be regular files with relative paths. The installer rejects traversal, Windows device aliases, ADS, symlinks and unexpected sizes, and activates only fully extracted components.

Run the real portable install/generate acceptance test documented in `docs/AUDIO_WORKBENCH.md` before distribution. This tests the actual Rust installer and Python tree in a fresh location, not the original venv.

## Upload

```powershell
node scripts/upload-music-workbench.mjs artifacts/music-workbench/release
```

This verifies all local hashes, creates the shared Release as **draft + prerelease** if absent, uploads missing assets with retry, verifies GitHub asset digests, then uploads the manifest last. Existing immutable assets are reused only if size and digest match. It never overwrites assets and does not change an existing Release's publication state. Publish the reviewed shared resource Release as a prerelease with `make_latest=false`; application updater Latest must remain the application release.

Publish the resource Release before distributing an app version that references it. Draft assets are not available at the public download URLs used by the app: an unpublished resource Release will show “此版本的音频资源尚未发布”. Confirm all six parts and the versioned manifest are uploaded, then verify “检查下载大小” from the desktop app after publication. Offline import can use the complete local release directory before publication.

The manually dispatched `music-workbench-resources.yml` workflow performs the same build/upload on a prepared self-hosted Windows runner labelled `music-workbench`; repository variable `MUSIC_WORKBENCH_STAGING` identifies its curated input. App tag builds only include the lightweight control code and do not run this workflow.

## ACE-Step 1.5 and YuE2

The ongoing song-engine integration uses `modules/music_workbench/song-resources.json`. Each engine has its own immutable resource version, runtime and model component, alongside the unchanged MusicGen resources. Do not publish an application claiming support until the live acceptance checklist in `docs/AUDIO_ENGINES_INTEGRATION.md` passes.

```powershell
# Builder only: Python 3.12 with requests, uv on PATH, and the pinned official source checkout.
python scripts/prepare-song-resources.py --engine acestep --source C:\build\ACE-Step-1.5 --staging C:\build\acestep --cache C:\build\downloads
python scripts/prepare-song-resources.py --engine yue2 --source C:\build\YuE --staging C:\build\yue2 --cache C:\build\downloads --model-source C:\existing\models
python scripts/verify-song-engine.py --engine yue2 --resources C:\build\yue2 --output C:\build\new-yue2-validation
python scripts/package-music-workbench.py --engine yue2 --staging C:\build\yue2 --output artifacts/music-workbench/release-yue2
node scripts/upload-music-workbench.mjs artifacts/music-workbench/release-yue2 yue2
```

Use `acestep` in the equivalent verification/package/upload commands. `--model-source` expects `YuE2-3B/` and `YuE2-Vae/`; only weight files matching the pinned repository's SHA256 are reused. `--torch-source <site-packages>` optionally copies an exact-version torch wheel installation for YuE2, including its distribution metadata and license notices. Existing environments and reference checkouts are not modified. The script exports the pinned Git commit, so local WebUI changes never enter the runtime. The official Python embeddable ZIP is SHA256-pinned and `_pth` restricts imports to the portable tree. `requirements-lock.txt` records every installed dependency.

The prepared `2026.10.11-acestep` set contains 10 parts, totaling 8,605,753,923 download bytes and 12,495,192,040 installed bytes. `2026.10.11-yue2` contains 11 parts, totaling 9,332,598,511 download bytes and 12,503,247,378 installed bytes. These versions are immutable; a changed archive needs a new resource version. Each offline folder must include its JSON manifest and every part, without manual extraction.

Pass `--duration 180` to `verify-song-engine.py` for a longer acceptance sample. Native UI checks use `MUSIC_TEST_ENGINE`, `MUSIC_TEST_ASSETS`, `MUSIC_UI_OUTPUT` and the isolated `MUSIC_QA_IDENTIFIER`; `scripts/verify-music-native-lifecycle.mjs` covers instrumental generation and window close, `--after-restart` checks recovery, and `--install-cache` checks preserved works while another engine is being installed. The latter requires both song engines installed and MusicGen absent in the isolated app. Never target the production application data directory.

ACE-Step packages only native Turbo inference dependencies, the 2B DiT, official VAE and Qwen3-Embedding-0.6B; no server, training environment or optional 5Hz LM. Its checkpoint-side Python code is synced from the pinned official commit during preparation, as the upstream handler expects, before recording model hashes. YuE2 code is Apache-2.0, weights are CC-BY-NC-4.0; retain model cards and all notices. No third-party WebUI code is redistributed.

The resource workflow accepts an engine choice and reads `MUSIC_ACESTEP_STAGING` / `MUSIC_YUE2_STAGING` for prepared song resources. It does not download models on app tag builds. Upload appends new immutable assets to the same resource prerelease and leaves old files and application Latest intact.
