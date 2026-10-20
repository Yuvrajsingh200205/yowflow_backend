# Meta Lead Ads Integration

## Architecture

Meta Page leadgen webhook calls `GET/POST /api/v1/integrations/meta/webhook`. The backend verifies Meta, retrieves the full lead from Graph API, normalizes fields, deduplicates by Meta lead id, and writes into the existing `leads` table.

Production callback URL:

```text
https://<your-api-domain>/api/v1/integrations/meta/webhook
```

## Environment

Set these in the backend runtime, never in source:

- `META_APP_ID`
- `META_APP_SECRET`
- `META_PAGE_ID`
- `META_PAGE_ACCESS_TOKEN`
- `META_WEBHOOK_VERIFY_TOKEN`
- `META_GRAPH_API_VERSION` (default: `v26.0`)

## Organization Mapping

Meta Page to CRM organization is DB-backed through `meta_lead_integrations`.

Example operator SQL:

```sql
INSERT INTO meta_lead_integrations (organization_id, page_id, page_name, updated_at)
VALUES ('<organization_uuid>', '<meta_page_id>', '<your_page_name>', now())
ON CONFLICT (page_id) DO UPDATE
SET organization_id = EXCLUDED.organization_id,
    page_name = EXCLUDED.page_name,
    is_active = true,
    updated_at = now();
```

## Webhook Verification

Meta sends `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`. The backend returns the plain challenge only when the token matches `META_WEBHOOK_VERIFY_TOKEN`.

## Lead Flow

1. Meta posts a Page `leadgen` change.
2. Backend validates `X-Hub-Signature-256` using `META_APP_SECRET`.
3. Backend checks the webhook Page id against `META_PAGE_ID`.
4. Backend finds `meta_lead_integrations.page_id`.
5. Backend calls Graph API for the configured lead id.
6. Backend maps common fields like name, phone, email, city, event date, and budget.
7. Backend upserts into `leads` using `(organization_id, external_provider, external_id)`.

## Deduplication

`leads` has a unique index on `(organization_id, external_provider, external_id)`. Retried Meta webhooks update metadata and do not create duplicate CRM leads.

## Page Subscription

After the webhook URL verifies in Meta App Dashboard, subscribe the configured Page to the `leadgen` field. Do this from Meta App Dashboard or by an operator-owned Graph API call with a valid Page access token:

```bash
curl -X POST "https://graph.facebook.com/v26.0/<PAGE_ID>/subscribed_apps" \
  -d "subscribed_fields=leadgen" \
  -d "access_token=<PAGE_ACCESS_TOKEN>"
```

Meta Dashboard clicks:

1. Open Meta Developers.
2. Select the your Meta app.
3. Go to **Webhooks**.
4. Choose product/object **Page**.
5. Add callback URL `https://<your-api-domain>/api/v1/integrations/meta/webhook`.
6. Paste the same value configured in `META_WEBHOOK_VERIFY_TOKEN`.
7. Click **Verify and Save**.
8. Subscribe the Page your Facebook Page to the `leadgen` field.
9. Confirm the Page is connected to the app and the Page access token belongs to this Page.
10. Submit a test Instant Form lead and confirm it appears in CRM Leads & Inquiries with source `Meta Lead Ads`.

## Production Checklist

- App is in Live mode when production traffic starts.
- App Review/permissions are approved for lead retrieval.
- Page access token belongs to the connected Page and has required Page/lead permissions.
- Webhook callback URL is public HTTPS.
- `meta_lead_integrations` contains the Page-to-organization row.
- Backend logs are monitored for `Meta webhook processing completed`.

## Security Notes

The webhook never accepts an arbitrary URL. It only calls `https://graph.facebook.com/<configured-version>/<leadgen-id>`. Secrets and tokens are redacted from logs. Lead PII is stored in the database but not logged.
