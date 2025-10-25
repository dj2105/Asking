# Sealed Pack Workflow — Super Simple Guide

This walkthrough keeps everything as easy as possible. Follow each step in order to create sealed packs and use them inside the game without ever exposing plaintext questions.

---

## 1. One-time setup

1. **Install Python 3.10 or newer.** On Windows or macOS, install from [python.org](https://www.python.org/downloads/). On Linux, use your package manager. Make sure `python` works in your terminal:
   ```bash
   python --version
   ```
2. **Install Git** so you can download the repo (skip if you already have it):
   ```bash
   git --version
   ```
3. **Optional but recommended:** install the Codex runner so you can run the canned commands:
   ```bash
   npm install --global @codex-cli/runner
   ```
   If you skip this you can run the Python script directly later.
4. **(If you need Firestore writes)** download a Google Cloud service-account JSON and note its path for later. You can still run everything offline without this file, but the start command will skip Firestore writes.

---

## 2. Grab the project files

1. Clone or copy the repository to your machine. The rest of the guide assumes the files live in a folder called `Asking`.
2. Open a terminal (PowerShell on Windows, Terminal on macOS/Linux) and move into that folder. Example:
   ```bash
   cd C:/Users/Spaniel/Downloads/Asking-man/Asking-main
   ```
   Adjust the path to wherever you saved the project.

---

## 3. Create a clean Python environment

1. Create a virtual environment:
   ```bash
   python -m venv .venv
   ```
2. Activate it:
   - Windows PowerShell:
     ```powershell
     .\.venv\Scripts\Activate.ps1
     ```
   - macOS/Linux:
     ```bash
     source .venv/bin/activate
     ```
3. Install the only two Python packages the workflow needs:
   ```bash
   python -m pip install --upgrade pip
   python -m pip install firebase-admin
   ```
   (If OpenSSL is missing on your machine, add `cryptography` to that list — it bundles a compatible library.)

4. If you have the Firestore credentials file from Step 1, point the environment variable at it:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/service-account.json
   ```
   On PowerShell use:
   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\full\\path\\service-account.json"
   ```

---

## 4. Generate sealed packs (questions + maths)

You only need to run this whenever you want a fresh pair of packs.

### Option A — with Codex (shortest command)
```bash
codex run generate-sealed-pack --out packs/new
```

### Option B — direct Python (no Codex needed)
```bash
python ops/sealed_workflow.py generate --out packs/new
```

The command will:

1. Look in `packs/new`.
2. Create `QPACK_YYYYMMDD_HHMMSS.sealed` + `.json` **and** `MPACK_YYYYMMDD_HHMMSS.sealed` + `.json` if they are missing.
3. Re-use any existing file so you never overwrite a pair that you already generated.

You should end up with four new files, for example:
```
packs/new/QPACK_20240312_191500.sealed
packs/new/QPACK_20240312_191500.json
packs/new/MPACK_20240312_191500.sealed
packs/new/MPACK_20240312_191500.json
```

Tip: re-run the same command whenever the folder is empty — it only fills the gaps.

---

## 5. Start a room with the next unused sealed pair

When you are ready to play:

### Option A — with Codex
```bash
codex run start-game-with-new-pack
```

### Option B — direct Python
```bash
python ops/sealed_workflow.py start
```

What happens:

1. The script grabs the oldest matching `QPACK_*.sealed` + `MPACK_*.sealed` pair from `packs/new`.
2. It creates a three-letter/number room code (for example `AB3`).
3. Both sealed files and their JSON manifests move into `packs/used/AB3/` so they cannot be picked again.
4. If Firestore credentials are available it writes a tiny record at `rooms/AB3` describing which sealed files were used (filenames, hashes, timestamps). No plaintext questions are ever stored or printed.
5. The command prints a short JSON message such as `{"roomCode":"AB3"}` or, if nothing was waiting, `{"error":"no_packs_available"}`.

If you see `no_packs_available`, go back to Step 4 to generate a fresh pair and try again.

---

## 6. Use the room code inside the game

1. Open the game front-end (for local testing run `npm install` then `npm start` from the project root, or deploy the `/docs` site as usual).
2. Go to the **Key Room** screen.
3. Press **START GAME**. The front-end calls the same `start-game-with-new-pack` command:
   - If a room code arrives, it routes you straight to the Code Room showing that code.
   - If there are no packs available it shows a friendly warning; return to Step 4 to create new packs.
4. Share the room code with the guest player so they can join via the Lobby screen.

Once everyone is connected, the countdown begins and the trivia + maths blocks come from the sealed packs you generated earlier.

---

## 7. After the game

* The used sealed files stay in `packs/used/<ROOMCODE>/` for auditing. Leave them there so they are never re-used.
* To host another match, repeat **Step 4** (if necessary) and **Step 5** to grab the next pair.
* When you finish for the day, exit the virtual environment with `deactivate` (PowerShell/Linux/macOS) and close the terminal.

That’s it! These steps keep every pack sealed at rest, move each pair exactly once, and let the Key Room start new sessions safely.
