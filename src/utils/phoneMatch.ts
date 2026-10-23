import { Db } from '../config/prisma';

/** The last ten digits of a phone number, however it was typed (`+91 98123 45678`, `098123-45678`, …). */
export const lastTen = (phone: string) => phone.replace(/\D/g, '').slice(-10);

/** Finds this studio's existing client with the same mobile number, ignoring spaces, dashes and country codes. */
export async function clientIdByPhone(db: Db, organizationId: string, phone: string): Promise<string | null> {
  const digits = lastTen(phone);
  if (digits.length !== 10) return null;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM clients
     WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
       AND right(regexp_replace(primary_phone, '\\D', '', 'g'), 10) = ${digits}
     ORDER BY created_at ASC LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** An open lead for the same person and event date, so a second enquiry updates it instead of duplicating it. */
export async function openLeadIdByPhoneAndDate(db: Db, organizationId: string, phone: string, eventDate: Date): Promise<string | null> {
  const digits = lastTen(phone);
  if (digits.length !== 10) return null;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM leads
     WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL AND status NOT IN ('WON', 'LOST')
       AND event_date = ${eventDate}::date
       AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = ${digits}
     ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.id ?? null;
}
