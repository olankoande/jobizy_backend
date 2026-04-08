import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { PoolConnection } from "mysql2/promise";
import { createId } from "../core/store";

type InvoiceInput = {
  paymentId: string;
  userId: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  billingName: string | null;
};

type InvoiceRecord = {
  id: string;
  payment_id: string;
  invoice_number: string;
  billing_name: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  pdf_url: string | null;
  pdf_path?: string | null;
  issued_at: string | null;
};

export type GeneratedInvoice = InvoiceRecord;

const INVOICE_COLORS = {
  ink: "#14213d",
  muted: "#6b7280",
  accent: "#c97a2b",
  accentSoft: "#f4e4d0",
  border: "#e5ddd1",
  panel: "#fbf8f3",
  white: "#ffffff",
};

function formatMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("fr-CA", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function formatInvoiceDate(value?: string | null) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

function ensureInvoiceDirectory() {
  const dir = path.resolve(process.cwd(), "storage", "invoices");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildInvoiceNumber() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `INV-${year}${month}${day}-${suffix}`;
}

async function loadUserBillingInfo(connection: PoolConnection, userId: string) {
  const [rows] = await connection.query<any[]>(
    `SELECT id, first_name, last_name, email
       FROM users
      WHERE id = ?`,
    [userId],
  );

  const user = (rows as any[])[0] ?? null;
  if (!user) {
    return {
      billingName: null,
      email: null,
    };
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return {
    billingName: fullName || user.email || null,
    email: user.email ?? null,
  };
}

async function writePdf(filePath: string, invoice: InvoiceRecord) {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);
    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - 100;

    const drawLabelValue = (label: string, value: string, y: number) => {
      doc
        .fillColor(INVOICE_COLORS.muted)
        .font("Helvetica")
        .fontSize(10)
        .text(label.toUpperCase(), 50, y, { width: 140 });
      doc
        .fillColor(INVOICE_COLORS.ink)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(value, 50, y + 14, { width: 220 });
    };

    const drawAmountRow = (label: string, value: string, y: number, strong = false) => {
      doc
        .fillColor(strong ? INVOICE_COLORS.ink : INVOICE_COLORS.muted)
        .font(strong ? "Helvetica-Bold" : "Helvetica")
        .fontSize(strong ? 12 : 11)
        .text(label, 70, y, { width: 220 });
      doc
        .fillColor(INVOICE_COLORS.ink)
        .font(strong ? "Helvetica-Bold" : "Helvetica")
        .fontSize(strong ? 14 : 11)
        .text(value, pageWidth - 170, y, { width: 100, align: "right" });
    };

    doc.pipe(stream);

    doc.roundedRect(50, 40, contentWidth, 110, 20).fill(INVOICE_COLORS.ink);
    doc
      .fillColor(INVOICE_COLORS.accentSoft)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("JOBIZY", 70, 62, { characterSpacing: 2 });
    doc
      .fillColor(INVOICE_COLORS.white)
      .font("Helvetica-Bold")
      .fontSize(28)
      .text("Facture de paiement", 70, 84);
    doc
      .fillColor("#d7deeb")
      .font("Helvetica")
      .fontSize(11)
      .text("Document emis automatiquement pour confirmer votre transaction Jobizy.", 70, 118, {
        width: 320,
      });

    doc.roundedRect(390, 62, 190, 66, 14).fill("#20304f");
    doc
      .fillColor("#d7deeb")
      .font("Helvetica")
      .fontSize(9)
      .text("TOTAL REGLE", 410, 78, { width: 150, align: "right" });
    doc
      .fillColor(INVOICE_COLORS.white)
      .font("Helvetica-Bold")
      .fontSize(22)
      .text(formatMoney(invoice.total_cents, invoice.currency), 410, 92, { width: 150, align: "right" });

    drawLabelValue("Numero", invoice.invoice_number, 182);
    drawLabelValue("Emission", formatInvoiceDate(invoice.issued_at), 182);
    doc.x = 330;
    doc
      .fillColor(INVOICE_COLORS.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("STATUT", 330, 182, { width: 100 });
    doc.roundedRect(330, 198, 108, 24, 12).fill(INVOICE_COLORS.accentSoft);
    doc
      .fillColor(INVOICE_COLORS.accent)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Paiement confirme", 345, 205, { width: 80, align: "center" });

    doc.roundedRect(50, 248, 250, 108, 18).fill(INVOICE_COLORS.panel).stroke(INVOICE_COLORS.border);
    doc
      .fillColor(INVOICE_COLORS.ink)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("Facture a", 70, 270);
    if (invoice.billing_name) {
      doc
        .fillColor(INVOICE_COLORS.ink)
        .font("Helvetica-Bold")
        .fontSize(18)
        .text(invoice.billing_name, 70, 294, { width: 190 });
    } else {
      doc
        .fillColor(INVOICE_COLORS.ink)
        .font("Helvetica-Bold")
        .fontSize(18)
        .text("Client Jobizy", 70, 294, { width: 190 });
    }
    doc
      .fillColor(INVOICE_COLORS.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("Transaction enregistree et disponible dans votre espace de facturation.", 70, 324, {
        width: 190,
      });

    doc.roundedRect(320, 248, 270, 168, 18).fill(INVOICE_COLORS.white).stroke(INVOICE_COLORS.border);
    doc
      .fillColor(INVOICE_COLORS.ink)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("Resume de facturation", 340, 270);
    doc.moveTo(340, 300).lineTo(570, 300).strokeColor(INVOICE_COLORS.border).lineWidth(1).stroke();
    drawAmountRow("Sous-total", formatMoney(invoice.subtotal_cents, invoice.currency), 322);
    drawAmountRow("Taxes", formatMoney(invoice.tax_cents, invoice.currency), 352);
    doc.moveTo(340, 382).lineTo(570, 382).strokeColor(INVOICE_COLORS.border).lineWidth(1).stroke();
    drawAmountRow("Total regle", formatMoney(invoice.total_cents, invoice.currency), 394, true);

    doc.roundedRect(50, 384, contentWidth, 120, 18).fill("#fffaf2").stroke(INVOICE_COLORS.border);
    doc
      .fillColor(INVOICE_COLORS.ink)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("Details", 70, 406);
    doc
      .fillColor(INVOICE_COLORS.muted)
      .font("Helvetica")
      .fontSize(11)
      .text(
        "Cette facture confirme le paiement de frais sur Jobizy. Conservez-la pour vos dossiers comptables ou administratifs.",
        70,
        432,
        { width: 500, lineGap: 4 },
      );

    doc
      .fillColor(INVOICE_COLORS.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("Merci d'utiliser Jobizy.", 50, 540);
    doc.end();

    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.on("error", reject);
  });
}

export async function createInvoiceForPayment(connection: PoolConnection, input: InvoiceInput): Promise<GeneratedInvoice> {
  const [existingRows] = await connection.query<any[]>(
    `SELECT * FROM invoices WHERE payment_id = ?`,
    [input.paymentId],
  );
  const existingInvoice = (existingRows as any[])[0] as InvoiceRecord | undefined;
  if (existingInvoice) {
    return existingInvoice;
  }

  const invoiceId = createId("inv");
  const invoiceNumber = buildInvoiceNumber();
  const issuedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  const userInfo = await loadUserBillingInfo(connection, input.userId);

  await connection.execute(
    `INSERT INTO invoices (
      id, payment_id, invoice_number, billing_name, billing_address_json,
      subtotal_cents, tax_cents, total_cents, currency, issued_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      invoiceId,
      input.paymentId,
      invoiceNumber,
      input.billingName ?? userInfo.billingName,
      input.subtotalCents,
      input.taxCents,
      input.totalCents,
      input.currency,
      issuedAt,
    ],
  );

  const invoice: InvoiceRecord = {
    id: invoiceId,
    payment_id: input.paymentId,
    invoice_number: invoiceNumber,
    billing_name: input.billingName ?? userInfo.billingName,
    subtotal_cents: input.subtotalCents,
    tax_cents: input.taxCents,
    total_cents: input.totalCents,
    currency: input.currency,
    pdf_url: null,
    pdf_path: null,
    issued_at: issuedAt,
  };

  const dir = ensureInvoiceDirectory();
  const fileName = `${invoice.invoice_number}.pdf`;
  const filePath = path.join(dir, fileName);
  await writePdf(filePath, invoice);

  const appBaseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3001"}`;
  const pdfUrl = `${appBaseUrl}/static/invoices/${encodeURIComponent(fileName)}`;

  await connection.execute(
    `UPDATE invoices SET pdf_url = ? WHERE id = ?`,
    [pdfUrl, invoice.id],
  );

  return {
    ...invoice,
    pdf_url: pdfUrl,
    pdf_path: filePath,
  };
}
