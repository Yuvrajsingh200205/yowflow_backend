# Secrets to rotate before selling

These values belonged to the previous project/deployment. Treat them as exposed and replace them for every new customer deployment.

| Secret | Where it lives | Action |
| --- | --- | --- |
| `DATABASE_URL` (old Neon, us-east-2) | previous Vercel env / local `.env` | Delete the old branch/role; use a fresh Neon project per deployment |
| `JWT_SECRET`, `REFRESH_TOKEN_SECRET` | env | `openssl rand -base64 48` for each; changing them signs everyone out |
| `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN` | env | Create a new Meta app per customer; never reuse the previous client's app |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | env | New bucket + keys per deployment |
| `SEED_ADMIN_PASSWORD` | env | Change after first login; do not seed demo data in production (`SEED_DEMO_DATA=false`) |
| Vercel project env of the old deployment | Vercel dashboard | Remove, or delete the old project |

No secrets were found in git history (scanned for private keys, `DATABASE_URL=` values and provider key patterns).

White-label identity is configured with `BRAND_NAME`, `BRAND_COOKIE_PREFIX` and `BRAND_SUPPORT_EMAIL`. Changing `BRAND_COOKIE_PREFIX` (and the frontend's `NEXT_PUBLIC_BRAND_COOKIE_PREFIX`) invalidates existing sessions.
