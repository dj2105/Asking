# Firebase Hosting pull request preview setup

This guide walks through adding an automatic Firebase Hosting preview for every pull request so reviewers can open a live build without cloning the branch. The instructions assume you are working on Windows 10/11 with PowerShell. Notes are included for doing the administrative steps from an iPad.

## 1. Prerequisites

- A Firebase project that already serves this app (`firebase.json` in the repo must include a `hosting` block that points at the app files).
  - If you have only been using the emulators so far, add the following under the top-level braces before running the workflow:
    ```json
    "hosting": {
      "public": ".",
      "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
      "rewrites": [{ "source": "**", "destination": "/index.html" }]
    }
    ```
- Owner or Editor access to that Firebase project so you can create service accounts and secrets.
- GitHub repository admin permissions (needed to add secrets and workflows).

## 2. Prepare Firebase credentials (Windows)

1. Install Node.js 18+ from [nodejs.org](https://nodejs.org/en/download/) if you do not have it.
2. Install the Firebase CLI globally:
   ```powershell
   npm install -g firebase-tools
   ```
3. Authenticate the CLI:
   ```powershell
   firebase login
   ```
4. Make sure the CLI knows which Firebase project you are using (replace `your-project-id`):
   ```powershell
   firebase use your-project-id
   ```
5. Create a dedicated service account credential for GitHub Actions:
   - Open the [Google Cloud Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) page.
   - Create a new service account (e.g. `github-firebase-preview`).
   - Grant it the **Firebase Hosting Admin** and **Service Account Token Creator** roles.
   - Generate a JSON key file and download it. This file contains your credentials.
6. Open the JSON key in a text editor (Notepad works) and keep the contents handy—you will paste the entire JSON (including braces) into GitHub in the next section.

> **On an iPad?** You can complete the same steps entirely in Safari/Chrome. When the JSON key downloads, open it in the Files app, tap the share icon, and copy the text into a secure notes app until you paste it into GitHub. Delete the local copy afterwards.

## 3. Add GitHub repository secrets

1. Navigate to your repository → **Settings** → **Secrets and variables** → **Actions**.
2. Add a new secret named `FIREBASE_SERVICE_ACCOUNT` and paste the entire JSON key value from step 2.6 (multi-line secrets are supported).
3. (Recommended) Add another secret named `FIREBASE_PROJECT_ID` containing the project ID so the workflow can target it explicitly. If you skip this step, the workflow will fall back to the `project_id` field inside the service-account JSON.

All of these steps can be completed in the GitHub web UI from either Windows or an iPad.

## 4. Create the GitHub Actions workflow

1. Create `.github/workflows/pr-preview.yml` in the repository with the contents below.
2. Commit and push the file to your default branch (usually `main`).

```yaml
name: Firebase PR preview

on:
  pull_request:
    branches:
      - main

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  preview:
    name: Deploy preview channel
    runs-on: ubuntu-latest
    if: ${{ !github.event.pull_request.head.repo.fork }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Firebase CLI
        run: npm install -g firebase-tools

      - name: Deploy preview
        uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
          channelId: pr-${{ github.event.number }}
          projectId: ${{ secrets.FIREBASE_PROJECT_ID || fromJson(secrets.FIREBASE_SERVICE_ACCOUNT).project_id }}
```

### How it works

- The workflow runs on every pull request targeting `main`.
- `FirebaseExtended/action-hosting-deploy` deploys the current commit to a preview channel named after the PR number. It automatically comments on the PR with the preview URL.
- Preview channels created by this command expire automatically after 7 days; adjust the lifetime by adding `expires: 3d` (or similar) under the action inputs if you prefer a different duration.
- The job is skipped for forks so external contributors do not consume your Firebase quotas.
- The explicit `permissions` block grants GitHub’s `GITHUB_TOKEN` the rights the deploy action needs to write status checks and PR comments. Without it, the job fails with `Resource not accessible by integration` when it tries to publish the deployment status.
- The `projectId` input reads `FIREBASE_PROJECT_ID` when it exists and falls back to the `project_id` inside the service-account JSON. If you ever see "No currently active project" in the deploy logs, double-check that at least one of those sources carries the correct value.

## 5. Optional: emulator checks before deploying

To ensure broken builds do not deploy, add your test commands before the "Deploy preview" step. For example:
```yaml
      - name: Install dependencies
        run: npm ci

      - name: Run lint and tests
        run: npm test
```

## 6. Using the preview links

- After the workflow runs, the **github-actions** bot posts a comment in the PR Conversation tab with the preview URL (look for the "Firebase Hosting Deployment" card).
- GitHub also surfaces the same URL in the PR header under the **Deployments** pill and inside the **Checks → Firebase PR preview** summary. You can open the deployment details from any of those entry points.
- Open the preview link on any device (desktop, mobile, iPad) to exercise the change with production-like Firebase services. If you need two devices simultaneously (e.g. Windows laptop + iPad), open the same URL on both and log in as the different roles.
- When the PR closes or merges, the preview channel will expire automatically after the configured period.

### If you opened a PR before adding the workflow

The Action definition lives on the base branch (`main`). If you created a pull request before merging `.github/workflows/pr-preview.yml`, that older PR will not run the job until it sees a new event **after** the workflow exists on `main`. You have a few options:

1. Push another commit to the same branch (or amend/rebase and force-push). Any new commit event against the PR re-runs the workflow and publishes the preview comment/link.
2. If you do not have further edits to push, close the PR and immediately reopen it. GitHub treats the reopen as a fresh event and re-evaluates workflows from `main`.
3. As a last resort, create a new branch from your current work and open a new PR targeting `main`. The first open event will kick off the preview deployment.

After one of these actions fires, check the PR’s **Checks** tab to confirm the `Firebase PR preview` workflow ran successfully. Once it finishes, the Deployments pill and bot comment will appear with the preview URL.

## 7. Revoking access

If the credentials are ever compromised, delete the `FIREBASE_SERVICE_ACCOUNT` secret and revoke the key in the Google Cloud Console. Then repeat the setup with a new key.

---

### Quick recap

1. Create a Firebase service account (Windows PowerShell or iPad web tools).
2. Store the service account JSON and project ID as GitHub secrets.
3. Add the GitHub Actions workflow above.
4. Merge to `main`. Every future PR gets its own live preview link.

# PR Preview Deploys

The Firebase preview workflow deploys each pull request to a temporary channel. The `projectId` input now falls back to the `project_id` field inside the JSON service account when the explicit `FIREBASE_PROJECT_ID` secret is absent.

```yaml
projectId: ${{ secrets.FIREBASE_PROJECT_ID || fromJson(secrets.FIREBASE_SERVICE_ACCOUNT).project_id }}
```

This keeps the deploy step working whether you store the project ID as a dedicated secret or only inside the service account blob.
