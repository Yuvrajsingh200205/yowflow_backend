import PDFDocument from 'pdfkit';
import { getEmployeePerformanceReport } from '../services/attendance.service';
import { brand } from '../config/brand';

type PerformanceReport = Awaited<ReturnType<typeof getEmployeePerformanceReport>>;

const BRAND = '#8f3655';
const INK = '#292427';
const MUTED = '#716a6d';

const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const money = (value: number) => `INR ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)}`;

function metric(doc: PDFKit.PDFDocument, x: number, y: number, label: string, value: string, hint?: string) {
  doc.roundedRect(x, y, 166, 64, 8).fillAndStroke('#fbf8f6', '#eadfd9');
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), x + 11, y + 10);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(value, x + 11, y + 25, { width: 142, ellipsis: true });
  if (hint) doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(hint, x + 11, y + 46, { width: 142, ellipsis: true });
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string, y: number) {
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), 46, y);
  doc.moveTo(46, y + 18).lineTo(550, y + 18).lineWidth(0.7).strokeColor('#eadfd9').stroke();
}

/** Server-rendered version of the Team & Attendance performance report. */
export async function createPerformanceReportPdf(report: PerformanceReport): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 46, info: { Title: `Performance report — ${report.employee.fullName}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.rect(0, 0, 595, 112).fill(BRAND);
  doc.fillColor('#f8e6ec').font('Helvetica-Bold').fontSize(9).text('TEAM & ATTENDANCE · PERFORMANCE REPORT', 46, 34);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text(report.employee.fullName, 46, 52);
  doc.fillColor('#f8e6ec').font('Helvetica').fontSize(10).text(`${report.month} · ${report.employee.employeeCode || 'Employee report'}`, 46, 82);

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Monthly overview', 46, 137);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`Shift: ${report.employee.shift.start || 'Not set'} – ${report.employee.shift.end || 'Not set'}`, 46, 155);
  metric(doc, 46, 179, 'Present', String(report.attendance.present), `${report.attendance.halfDay} half-day · ${report.attendance.absent} absent`);
  metric(doc, 216, 179, 'Working hours', hours(report.attendance.workingMinutes), `Expected ${hours(report.attendance.expectedMinutes)}`);
  metric(doc, 386, 179, 'Undertime', hours(report.attendance.undertimeMinutes), `${report.attendance.late} late arrival(s)`);
  metric(doc, 46, 253, 'Calculated salary', money(report.salary.calculatedSalary), `${report.attendance.payableDays} payable day(s) · ${money(report.salary.dailyRate)}/day`);
  metric(doc, 216, 253, 'Tasks complete', `${report.performance.completedTasks}/${report.performance.assignedTasks}`, `${report.performance.completionRate}% completion`);
  metric(doc, 386, 253, 'Shoot assignments', String(report.performance.shootAssignments), `${hours(report.performance.trackedWorkMinutes)} across ${report.performance.trackedWorkSessions} session(s)`);

  sectionTitle(doc, 'Attendance & payroll', 350);
  const payroll = [
    ['Present days', String(report.attendance.present)], ['Half days', String(report.attendance.halfDay)],
    ['Leave days', String(report.attendance.onLeave)], ['Absent days', String(report.attendance.absent)],
    ['Payable days', String(report.attendance.payableDays)], ['Daily rate', money(report.salary.dailyRate)],
    ['Working hours', hours(report.attendance.workingMinutes)], ['Expected hours', hours(report.attendance.expectedMinutes)],
    ['Undertime', hours(report.attendance.undertimeMinutes)], ['Calculated salary', money(report.salary.calculatedSalary)],
  ];
  payroll.forEach(([label, value], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 46 + col * 252;
    const y = 380 + row * 25;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, x, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(value, x + 150, y, { width: 100, align: 'right' });
    doc.moveTo(x, y + 17).lineTo(x + 250, y + 17).lineWidth(0.4).strokeColor('#eee6e2').stroke();
  });

  sectionTitle(doc, 'Work performance', 518);
  const work = [
    ['Assigned tasks', String(report.performance.assignedTasks)], ['Completed tasks', String(report.performance.completedTasks)],
    ['Task completion', `${report.performance.completionRate}%`], ['Tracked work sessions', String(report.performance.trackedWorkSessions)],
    ['Tracked work hours', hours(report.performance.trackedWorkMinutes)], ['Shoot assignments', String(report.performance.shootAssignments)],
  ];
  work.forEach(([label, value], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 46 + col * 252;
    const y = 548 + row * 25;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, x, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(value, x + 150, y, { width: 100, align: 'right' });
    doc.moveTo(x, y + 17).lineTo(x + 250, y + 17).lineWidth(0.4).strokeColor('#eee6e2').stroke();
  });
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(`Generated by ${brand.name} · This report uses authoritative attendance and payroll data.`, 46, 748, { width: 500, align: 'center' });
  doc.end();
  return complete;
}
