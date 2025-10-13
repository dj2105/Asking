# PR Preview Deploys

The Firebase preview workflow deploys each pull request to a temporary channel. The `projectId` input now falls back to the `project_id` field inside the JSON service account when the explicit `FIREBASE_PROJECT_ID` secret is absent.

```yaml
projectId: ${{ secrets.FIREBASE_PROJECT_ID || fromJson(secrets.FIREBASE_SERVICE_ACCOUNT).project_id }}
```

This keeps the deploy step working whether you store the project ID as a dedicated secret or only inside the service account blob.
