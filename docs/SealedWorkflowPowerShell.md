# Sealed Pack Workflow (PowerShell Quickstart)

This guide walks through the exact PowerShell commands needed to run Jemima's sealed-pack workflow on Windows. The examples assume the repository lives at:

```
C:\Users\Spaniel\Downloads\Asking-man\Asking-main
```

Adjust paths if you keep the project elsewhere.

## 1. Open a PowerShell session

Open **Windows Terminal** or **PowerShell** (Run as Administrator only when installing system tools). Then change into the repository root:

```powershell
Set-Location "C:\Users\Spaniel\Downloads\Asking-man\Asking-main"
```

> All subsequent commands run from this directory unless noted.

## 2. Install prerequisites

1. **Python 3.10+** – verify it is available:
   ```powershell
   python --version
   ```
   If you see `Python 3.x.x`, you are good to proceed. Otherwise install Python from [python.org](https://www.python.org/downloads/windows/) and enable the *Add python.exe to PATH* option during setup.

2. **Git** – confirm with:
   ```powershell
   git --version
   ```

3. **OpenSSL runtime (Windows)** – the workflow encrypts data with OpenSSL. Install the Win64 OpenSSL light package (e.g. from https://slproweb.com/products/Win32OpenSSL.html) and note the installation folder, commonly `C:\Program Files\OpenSSL-Win64`. After installation, make sure `libcrypto-3-x64.dll` (or `libcrypto-1_1-x64.dll` on older builds) resides in that folder.

4. **Optional: Visual C++ runtime** – recent OpenSSL builds depend on the Visual C++ Redistributable (2022). Install it from Microsoft if prompted.

## 3. Prepare a virtual environment

Create and activate a local Python environment inside the repo (prevents polluting global packages):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Upgrade pip and install the required Python dependencies:

```powershell
python -m pip install --upgrade pip
python -m pip install firebase-admin cryptography
```

> `cryptography` is optional but provides a bundled OpenSSL implementation; installing it keeps the workflow working even if system OpenSSL is unavailable.

## 4. Point to Firestore credentials

If the workflow will push metadata to Google Cloud, set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to a service-account JSON file with Firestore access:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Path\To\service-account.json"
```

Leave this step out if you are running purely offline; the `generate-sealed-pack` command does not contact Firebase.

## 5. Ensure the `codex` runner is available

The repository defines Codex tasks in `codex.yaml`. Install the CLI globally (only once per machine):

```powershell
npm install --global @codex-cli/runner
```

Verify it is on PATH:

```powershell
codex --version
```

If you prefer not to install the CLI globally, you can run the underlying Python script directly (see Step 6b and 7b).

## 6. Generate sealed packs

### 6a. Via Codex (recommended)

Run the task; it creates any missing pair of sealed packs plus JSON manifests under `packs\new`:

```powershell
codex run generate-sealed-pack --out packs/new
```

Expected side effects:

* `packs\new\QPACK_YYYYMMDD_HHMMSS.sealed`
* `packs\new\QPACK_YYYYMMDD_HHMMSS.json`
* `packs\new\MPACK_YYYYMMDD_HHMMSS.sealed`
* `packs\new\MPACK_YYYYMMDD_HHMMSS.json`

Confirm the files exist:

```powershell
Get-ChildItem -Path .\packs\new -Filter "*PACK_*.sealed"
```

If the task reports that one pack already exists, it will only create the missing counterpart.

### 6b. Direct Python fallback

If Codex is unavailable, invoke the workflow script directly (output is identical):

```powershell
python .\ops\sealed_workflow.py generate --out packs/new
```

## 7. Start a game with the next unused pack pair

### 7a. Via Codex

```powershell
codex run start-game-with-new-pack
```

The command will:

1. Locate the oldest matching `QPACK_*.sealed` + `MPACK_*.sealed` pair in `packs\new`.
2. Generate a unique room code (e.g. `AB3`).
3. Move both `.sealed` files and their manifests into `packs\used\<ROOMCODE>` atomically.
4. Record metadata in Firestore at `rooms/<ROOMCODE>.seedSource` (requires credentials from Step 4).
5. Print a JSON response such as `{"roomCode":"AB3"}` or `{"error":"no_packs_available"}`.

After a successful run, verify the files moved:

```powershell
Get-ChildItem -Path .\packs\used
Get-ChildItem -Path .\packs\used\AB3
```

Replace `AB3` with the actual room code reported in the JSON response.

### 7b. Direct Python fallback

```powershell
python .\ops\sealed_workflow.py start
```

The behaviour and output mirror the Codex task.

## 8. Troubleshooting tips

* **`libcrypto` not found** – add the OpenSSL `bin` folder to the current session before running the command:
  ```powershell
  $env:Path = "C:\Program Files\OpenSSL-Win64\bin;" + $env:Path
  ```
  Alternatively, rely on the `cryptography` wheel installed in Step 3.

* **`firebase_admin` import error** – ensure the virtual environment is active and rerun:
  ```powershell
  python -m pip install firebase-admin
  ```

* **Firestore permission issues** – confirm the service-account JSON has the `roles/datastore.user` (or stronger) role and that `GOOGLE_APPLICATION_CREDENTIALS` is still set in the active session.

* **No packs available** – rerun the generate step to produce a fresh pair.

* **Codex command not found** – re-open PowerShell after `npm install -g` so PATH updates. As an immediate workaround, use the direct Python commands.

## 9. Wrap up

To leave the virtual environment when finished:

```powershell
Deactivate
```

The workflow is now ready for regular use—just repeat steps 6 and 7 as you prepare new rooms.
