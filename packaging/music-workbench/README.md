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
