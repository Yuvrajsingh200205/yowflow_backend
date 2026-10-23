import path from 'path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { prisma } from '../config/prisma';
import { notFound } from '../utils/errors';
import { paymentPlan, todayIn } from '../utils/quotePricing';
import { toDateOnly } from '../utils/date';

/**
 * Quotation and invoice PDFs. The studio's own details, GST number, bank account and UPI QR are printed so the
 * document can be paid straight from it. Noto Sans is bundled because the standard PDF fonts have no rupee sign.
 */

const FONT_DIR = path.resolve(process.cwd(), 'assets', 'fonts');
const REGULAR = path.join(FONT_DIR, 'NotoSans-Regular.ttf');
const BOLD = path.join(FONT_DIR, 'NotoSans-Bold.ttf');
const INK = '#14170f';
const MUTED = '#5f6858';
const LINE = '#dfe4d6';
const SOFT = '#f5f7ef';
const LEFT = 46;
const RIGHT = 549;
const WIDTH = RIGHT - LEFT;

const inr = (n: number) => `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
const fmtDate = (d?: Date | string | null) => (d ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(d)) : '—');
const label = (s?: string | null) => (s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const safeHex = (c?: string | null) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#9ac72f');

interface Studio { name: string; legalName?: string | null; phone?: string | null; email?: string | null; website?: string | null; gstNumber?: string | null; panNumber?: string | null; address: string | null }
interface Pay { upiId?: string | null; bankAccountName?: string | null; bankName?: string | null; bankAccountNumber?: string | null; bankIfsc?: string | null; brandColor?: string | null; terms?: string | null }
interface Row { service: string; description?: string | null; inclusions?: string[]; quantity: number; unitLabel?: string | null; unitPrice: number; taxRate: number; discount: number; amount: number }

function start(title: string) {
  const doc = new PDFDocument({ size: 'A4', margin: LEFT, bufferPages: true, info: { Title: title } });
  doc.registerFont('r', REGULAR);
  doc.registerFont('b', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  return { doc, done };
}

function space(doc: PDFKit.PDFDocument, need: number) {
  if (doc.y + need > 780) doc.addPage();
}

function header(doc: PDFKit.PDFDocument, studio: Studio, accent: string, docTitle: string, meta: Array<[string, string]>) {
  doc.rect(0, 0, 595, 6).fill(accent);
  doc.fillColor(INK).font('b').fontSize(20).text(studio.name, LEFT, 34, { width: 300 });
  doc.font('r').fontSize(8.5).fillColor(MUTED);
  const contact = [studio.phone, studio.email, studio.website].filter(Boolean).join('  ·  ');
  if (contact) doc.text(contact, LEFT, doc.y + 2, { width: 320 });
  if (studio.address) doc.text(studio.address, LEFT, doc.y + 1, { width: 320 });
  const tax = [studio.gstNumber ? `GSTIN ${studio.gstNumber}` : null, studio.panNumber ? `PAN ${studio.panNumber}` : null].filter(Boolean).join('  ·  ');
  if (tax) doc.text(tax, LEFT, doc.y + 1, { width: 320 });
  const leftEnd = doc.y;

  doc.fillColor(INK).font('b').fontSize(15).text(docTitle, 380, 34, { width: RIGHT - 380, align: 'right' });
  let y = 56;
  for (const [k, v] of meta) {
    doc.font('r').fontSize(8.5).fillColor(MUTED).text(k, 380, y, { width: 70 });
    doc.font('b').fontSize(9).fillColor(INK).text(v, 450, y, { width: RIGHT - 450, align: 'right' });
    y += 14;
  }
  doc.y = Math.max(leftEnd, y) + 14;
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.y += 14;
}

function twoColumn(doc: PDFKit.PDFDocument, leftTitle: string, left: string[], rightTitle: string, right: string[]) {
  const top = doc.y;
  doc.font('b').fontSize(8).fillColor(MUTED).text(leftTitle.toUpperCase(), LEFT, top, { width: 240 });
  doc.font('r').fontSize(10).fillColor(INK);
  let y = top + 13;
  for (const line of left) { doc.text(line, LEFT, y, { width: 240 }); y = doc.y + 1; }
  const leftEnd = y;
  doc.font('b').fontSize(8).fillColor(MUTED).text(rightTitle.toUpperCase(), 310, top, { width: 239 });
  doc.font('r').fontSize(10).fillColor(INK);
  y = top + 13;
  for (const line of right) { doc.text(line, 310, y, { width: 239 }); y = doc.y + 1; }
  doc.y = Math.max(leftEnd, y) + 12;
}

const COLS = { desc: [LEFT, 258], qty: [308, 52], rate: [364, 70], tax: [438, 36], amt: [478, 71] } as const;

function tableHead(doc: PDFKit.PDFDocument, accent: string) {
  const y = doc.y;
  doc.rect(LEFT, y, WIDTH, 20).fill(SOFT);
  doc.fillColor(INK).font('b').fontSize(8);
  doc.text('DESCRIPTION', COLS.desc[0] + 6, y + 6, { width: COLS.desc[1] });
  doc.text('QTY', COLS.qty[0], y + 6, { width: COLS.qty[1], align: 'right' });
  doc.text('RATE', COLS.rate[0], y + 6, { width: COLS.rate[1], align: 'right' });
  doc.text('GST', COLS.tax[0], y + 6, { width: COLS.tax[1], align: 'right' });
  doc.text('AMOUNT', COLS.amt[0], y + 6, { width: COLS.amt[1] - 6, align: 'right' });
  doc.moveTo(LEFT, y + 20).lineTo(RIGHT, y + 20).lineWidth(1.2).strokeColor(accent).stroke();
  doc.y = y + 26;
}

function tableRows(doc: PDFKit.PDFDocument, rows: Row[], accent: string) {
  for (const r of rows) {
    doc.font('b').fontSize(10);
    const nameH = doc.heightOfString(r.service, { width: COLS.desc[1] });
    doc.font('r').fontSize(8.5);
    const sub = [r.description, ...(r.inclusions ?? []).map((i) => `•  ${i}`)].filter(Boolean).join('\n');
    const subH = sub ? doc.heightOfString(sub, { width: COLS.desc[1] }) : 0;
    const height = Math.max(nameH + (sub ? subH + 3 : 0), 14) + 10;
    if (doc.y + height > 770) { doc.addPage(); tableHead(doc, accent); }
    const y = doc.y;
    doc.fillColor(INK).font('b').fontSize(10).text(r.service, COLS.desc[0] + 6, y, { width: COLS.desc[1] });
    if (sub) doc.fillColor(MUTED).font('r').fontSize(8.5).text(sub, COLS.desc[0] + 6, y + nameH + 3, { width: COLS.desc[1] });
    doc.fillColor(INK).font('r').fontSize(9.5);
    doc.text(`${r.quantity}${r.unitLabel ? ` ${r.unitLabel}` : ''}`, COLS.qty[0], y, { width: COLS.qty[1], align: 'right' });
    doc.text(inr(r.unitPrice), COLS.rate[0], y, { width: COLS.rate[1], align: 'right' });
    doc.text(r.taxRate ? `${r.taxRate}%` : '—', COLS.tax[0], y, { width: COLS.tax[1], align: 'right' });
    doc.text(inr(r.amount), COLS.amt[0], y, { width: COLS.amt[1] - 6, align: 'right' });
    doc.y = y + height - 4;
    doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.y += 6;
  }
}

function totalsBlock(doc: PDFKit.PDFDocument, rows: Array<[string, string, boolean?]>, accent: string) {
  space(doc, rows.length * 18 + 20);
  doc.y += 4;
  for (const [k, v, strong] of rows) {
    const y = doc.y;
    if (strong) { doc.rect(318, y - 3, RIGHT - 318, 22).fill(SOFT); doc.moveTo(318, y - 3).lineTo(RIGHT, y - 3).lineWidth(1.2).strokeColor(accent).stroke(); }
    doc.fillColor(strong ? INK : MUTED).font(strong ? 'b' : 'r').fontSize(strong ? 11 : 9.5).text(k, 326, y + (strong ? 3 : 0), { width: 130 });
    doc.fillColor(INK).font(strong ? 'b' : 'r').fontSize(strong ? 12 : 9.5).text(v, 440, y + (strong ? 2 : 0), { width: RIGHT - 446, align: 'right' });
    doc.y = y + (strong ? 26 : 17);
  }
}

async function paymentBlock(doc: PDFKit.PDFDocument, studioName: string, pay: Pay, qr: { amount: number; note: string } | null) {
  const hasBank = Boolean(pay.bankAccountNumber);
  if (!pay.upiId && !hasBank) return;
  space(doc, 130);
  doc.y += 10;
  doc.font('b').fontSize(8).fillColor(MUTED).text('HOW TO PAY', LEFT, doc.y);
  doc.y += 6;
  const top = doc.y;
  let textX = LEFT;
  if (pay.upiId && qr && qr.amount > 0) {
    const link = `upi://pay?pa=${encodeURIComponent(pay.upiId)}&pn=${encodeURIComponent(studioName)}&am=${qr.amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(qr.note)}`;
    const png = await QRCode.toBuffer(link, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
    doc.image(png, LEFT, top, { width: 84, height: 84 });
    textX = LEFT + 98;
  }
  doc.fillColor(INK).font('r').fontSize(9.5);
  let y = top;
  if (pay.upiId) { doc.font('b').text('UPI', textX, y); doc.font('r').text(pay.upiId, textX, y + 12); y += 30; }
  if (hasBank) {
    doc.font('b').text('Bank transfer', textX, y);
    const lines = [pay.bankAccountName, pay.bankName, `A/c ${pay.bankAccountNumber}`, pay.bankIfsc ? `IFSC ${pay.bankIfsc}` : null].filter(Boolean) as string[];
    doc.font('r');
    lines.forEach((l, i) => doc.text(l, textX, y + 12 + i * 12));
    y += 12 + lines.length * 12;
  }
  doc.y = Math.max(top + 90, y) + 6;
}

function termsBlock(doc: PDFKit.PDFDocument, terms?: string | null) {
  if (!terms?.trim()) return;
  doc.font('r').fontSize(8.5);
  const h = doc.heightOfString(terms.trim(), { width: WIDTH });
  space(doc, Math.min(h + 30, 200));
  doc.y += 8;
  doc.font('b').fontSize(8).fillColor(MUTED).text('TERMS & CONDITIONS', LEFT, doc.y);
  doc.y += 4;
  doc.font('r').fontSize(8.5).fillColor(MUTED).text(terms.trim(), LEFT, doc.y, { width: WIDTH, lineGap: 1.5 });
}

function footers(doc: PDFKit.PDFDocument, studioName: string) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('r').fontSize(7.5).fillColor(MUTED).text(`${studioName}  ·  page ${i + 1} of ${range.count}`, LEFT, 812, { width: WIDTH, align: 'center', lineBreak: false });
  }
}

const studioOf = (o: { name: string; legalName: string | null; phone: string | null; email: string | null; website: string | null; gstNumber: string | null; panNumber: string | null; addressLine: string | null; city: string | null; state: string | null; postalCode: string | null }): Studio => ({
  name: o.name, legalName: o.legalName, phone: o.phone, email: o.email, website: o.website, gstNumber: o.gstNumber, panNumber: o.panNumber,
  address: [o.addressLine, o.city, o.state, o.postalCode].filter(Boolean).join(', ') || null,
});
const ORG_SELECT = { name: true, legalName: true, phone: true, email: true, website: true, gstNumber: true, panNumber: true, addressLine: true, city: true, state: true, postalCode: true, timezone: true } as const;

async function payOf(organizationId: string): Promise<Pay> {
  const s = await prisma.organizationSetting.findUnique({ where: { organizationId } });
  return { upiId: s?.upiId, bankAccountName: s?.bankAccountName, bankName: s?.bankName, bankAccountNumber: s?.bankAccountNumber, bankIfsc: s?.bankIfsc, brandColor: s?.brandColor, terms: s?.defaultTerms };
}

export async function createQuotationPdf(where: { id?: string; organizationId?: string; publicToken?: string }): Promise<{ buffer: Buffer; filename: string }> {
  const quote = await prisma.quotation.findFirst({
    where: { deletedAt: null, ...(where.id ? { id: where.id } : {}), ...(where.organizationId ? { organizationId: where.organizationId } : {}), ...(where.publicToken ? { publicToken: where.publicToken, status: { not: 'DRAFT' } } : {}) },
    include: { items: { orderBy: { sortOrder: 'asc' } }, organization: { select: ORG_SELECT } },
  });
  if (!quote) throw notFound('Quotation');
  const [pay] = await Promise.all([payOf(quote.organizationId)]);
  const studio = studioOf(quote.organization);
  const accent = safeHex(pay.brandColor);
  const { doc, done } = start(`Quotation ${quote.quotationNumber}`);

  header(doc, studio, accent, 'QUOTATION', [['Number', quote.quotationNumber], ['Date', fmtDate(quote.issueDate)], ['Valid until', fmtDate(quote.validUntil)]]);
  twoColumn(doc,
    'Prepared for', [quote.customerName ?? '—', quote.customerPhone ?? '', quote.customerEmail ?? ''].filter(Boolean),
    'Event', [label(quote.eventType) || 'Event', `${fmtDate(quote.eventDate)}${quote.eventDays > 1 ? ` · ${quote.eventDays} days` : ''}`, [quote.venueName, quote.venueCity].filter(Boolean).join(', '), quote.guestCount ? `${quote.guestCount} guests` : ''].filter(Boolean));

  const selected = quote.items.filter((i) => i.isSelected);
  const toRow = (i: (typeof selected)[number]): Row => ({ service: i.service, description: i.description, inclusions: i.inclusions, quantity: Number(i.quantity), unitLabel: i.unitLabel, unitPrice: Number(i.unitPrice), taxRate: Number(i.taxRate), discount: Number(i.discountAmount), amount: Number(i.quantity.times(i.unitPrice).minus(i.discountAmount)) });
  tableHead(doc, accent);
  tableRows(doc, selected.map(toRow), accent);

  const rates = new Set(selected.map((i) => Number(i.taxRate)).filter((r) => r > 0));
  totalsBlock(doc, [
    ['Subtotal', inr(Number(quote.subtotal))],
    ...(Number(quote.discountAmount) > 0 ? [['Discount', `− ${inr(Number(quote.discountAmount))}`] as [string, string]] : []),
    [rates.size === 1 ? `GST (${[...rates][0]}%)` : 'GST', inr(Number(quote.taxAmount))],
    ['Total', inr(Number(quote.grandTotal)), true],
  ], accent);

  const extras = quote.items.filter((i) => !i.isSelected);
  if (extras.length) {
    space(doc, 40 + extras.length * 13);
    doc.y += 10;
    doc.font('b').fontSize(8).fillColor(MUTED).text('OPTIONAL EXTRAS (NOT INCLUDED)', LEFT, doc.y);
    doc.y += 4;
    for (const e of extras) {
      const y = doc.y;
      doc.font('r').fontSize(9).fillColor(INK).text(e.service, LEFT, y, { width: 360 });
      doc.text(`${inr(Number(e.unitPrice))}${e.unitLabel ? ` / ${e.unitLabel}` : ''}`, 410, y, { width: RIGHT - 410, align: 'right' });
      doc.y = y + 13;
    }
  }

  const s = await prisma.organizationSetting.findUnique({ where: { organizationId: quote.organizationId }, select: { advancePercent: true, balanceDueDaysBefore: true } });
  const plan = paymentPlan(quote.grandTotal, quote.advancePercent ?? s?.advancePercent ?? 30, quote.balanceDueDaysBefore ?? s?.balanceDueDaysBefore ?? 7, quote.eventDate, toDateOnly(todayIn(quote.organization.timezone)));
  space(doc, 30 + plan.length * 15);
  doc.y += 10;
  doc.font('b').fontSize(8).fillColor(MUTED).text('PAYMENT SCHEDULE', LEFT, doc.y);
  doc.y += 4;
  for (const step of plan) {
    const y = doc.y;
    doc.font('r').fontSize(9.5).fillColor(INK).text(step.title, LEFT, y, { width: 150 });
    doc.text(`due ${fmtDate(step.dueDate)}`, 200, y, { width: 200 });
    doc.font('b').text(inr(Number(step.amount)), 410, y, { width: RIGHT - 410, align: 'right' });
    doc.y = y + 15;
  }

  await paymentBlock(doc, studio.name, pay, { amount: Number(plan[0]?.amount ?? 0), note: `${quote.quotationNumber} advance` });
  termsBlock(doc, quote.termsAndConditions ?? pay.terms);
  footers(doc, studio.name);
  doc.end();
  return { buffer: await done, filename: `${quote.quotationNumber}.pdf` };
}

export async function createInvoicePdf(organizationId: string, invoiceId: string): Promise<{ buffer: Buffer; filename: string }> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { items: { orderBy: { sortOrder: 'asc' } }, client: true, project: { select: { name: true, projectNumber: true } }, organization: { select: ORG_SELECT } },
  });
  if (!inv) throw notFound('Invoice');
  const pay = await payOf(organizationId);
  const studio = studioOf(inv.organization);
  const accent = safeHex(pay.brandColor);
  const { doc, done } = start(`Invoice ${inv.invoiceNumber}`);

  header(doc, studio, accent, studio.gstNumber && Number(inv.taxAmount) > 0 ? 'TAX INVOICE' : 'INVOICE', [['Number', inv.invoiceNumber], ['Date', fmtDate(inv.issueDate)], ['Due', fmtDate(inv.dueDate)], ['Status', label(inv.status)]]);
  twoColumn(doc,
    'Billed to', [inv.client.displayName, inv.client.primaryPhone, inv.client.primaryEmail ?? '', inv.client.gstNumber ? `GSTIN ${inv.client.gstNumber}` : ''].filter(Boolean),
    'For', [inv.project ? `${inv.project.name}` : 'Services', inv.project ? inv.project.projectNumber : ''].filter(Boolean));

  tableHead(doc, accent);
  tableRows(doc, inv.items.map((i) => ({ service: i.service, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), taxRate: Number(i.taxRate), discount: Number(i.discountAmount), amount: Number(i.quantity.times(i.unitPrice).minus(i.discountAmount)) })), accent);
  const rates = new Set(inv.items.map((i) => Number(i.taxRate)).filter((r) => r > 0));
  totalsBlock(doc, [
    ['Subtotal', inr(Number(inv.subtotal))],
    ...(Number(inv.discountAmount) > 0 ? [['Discount', `− ${inr(Number(inv.discountAmount))}`] as [string, string]] : []),
    [rates.size === 1 ? `GST (${[...rates][0]}%)` : 'GST', inr(Number(inv.taxAmount))],
    ['Total', inr(Number(inv.total)), true],
    ['Paid', inr(Number(inv.amountPaid))],
    ['Balance due', inr(Number(inv.amountDue)), true],
  ], accent);

  await paymentBlock(doc, studio.name, pay, Number(inv.amountDue) > 0 ? { amount: Number(inv.amountDue), note: `${inv.invoiceNumber}` } : null);
  termsBlock(doc, pay.terms);
  footers(doc, studio.name);
  doc.end();
  return { buffer: await done, filename: `${inv.invoiceNumber}.pdf` };
}

