import { Router } from "express";
import Stripe from "stripe";
import { queryOne, withTransaction } from "../core/db";
import { ApiError } from "../core/errors";
import { asyncHandler, ok } from "../core/http";
import { sendEventEmail } from "../services/email";
import { createInvoiceForPayment } from "../services/invoice";
import { createInAppNotification, publishRequest } from "../services/request-publication";
import { getStripeClient, getStripeWebhookSecret } from "../services/stripe";
import { createId } from "../core/store";

type StripeInvoiceLike = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
  payment_intent?: string | Stripe.PaymentIntent | null;
  tax?: number | null;
  customer_name?: string | null;
  lines?: {
    data?: Array<{
      period?: {
        start?: number | null;
        end?: number | null;
      };
    }>;
  };
  status_transitions?: {
    paid_at?: number | null;
  };
};

function resolveStripePeriodEnd(subscription: Stripe.Subscription, invoice?: StripeInvoiceLike | null) {
  const directPeriodEnd = (subscription as Stripe.Subscription & { current_period_end?: number | null }).current_period_end;
  if (typeof directPeriodEnd === "number") {
    return directPeriodEnd;
  }

  const invoiceLineEnds =
    invoice?.lines?.data
      ?.map((line) => line.period?.end ?? null)
      .filter((value): value is number => typeof value === "number") ?? [];
  if (invoiceLineEnds.length > 0) {
    return Math.max(...invoiceLineEnds);
  }

  const itemPeriodEnds =
    subscription.items.data
      .map((item) => {
        const typedItem = item as Stripe.SubscriptionItem & { current_period_end?: number | null };
        return typedItem.current_period_end ?? null;
      })
      .filter((value): value is number => typeof value === "number");

  if (itemPeriodEnds.length > 0) {
    return Math.max(...itemPeriodEnds);
  }

  return null;
}

async function markPaymentFailed(paymentIntentId: string) {
  let payment: any = null;

  await withTransaction(async (connection) => {
    const [paymentRows] = await connection.query<any[]>(
      `SELECT * FROM payments WHERE provider_payment_intent_id = ?`,
      [paymentIntentId],
    );
    payment = (paymentRows as any[])[0] ?? null;

    await connection.execute(
      `UPDATE payments
          SET status = 'failed', updated_at = NOW()
        WHERE provider_payment_intent_id = ?
          AND status NOT IN ('paid', 'refunded', 'partially_refunded')`,
      [paymentIntentId],
    );

    if (payment?.related_entity_type === "request" && payment.related_entity_id) {
      await connection.execute(
        `UPDATE requests
            SET status = 'draft', updated_at = NOW()
          WHERE id = ?
            AND status = 'payment_pending'`,
        [payment.related_entity_id],
      );
    }
  });

  if (payment?.user_id) {
    await createInAppNotification(
      null,
      payment.user_id,
      "request_publication_payment_failed",
      "Paiement de publication echoue",
      "Le paiement de publication de votre demande a echoue.",
    );
    await sendEventEmail({
      userId: payment.user_id,
      type: "request_publication_payment_failed",
      title: "Paiement de publication echoue",
      body: "Le paiement de publication de votre demande a echoue.",
    });
  }
}

async function handlePublicationCheckoutCompleted(session: Stripe.Checkout.Session) {
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

  if (!paymentIntentId) return;

  // Link the payment intent id to our pending payment record
  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE payments
          SET provider_payment_intent_id = ?, updated_at = NOW()
        WHERE provider_checkout_session_id = ?
          AND status = 'pending'`,
      [paymentIntentId, session.id],
    );
  });

  // payment_intent.succeeded fires BEFORE checkout.session.completed, so by the time
  // we get here the record had no payment_intent_id yet and the success handler was skipped.
  // Trigger it now if the session is already paid and the payment is still pending.
  if (session.payment_status === "paid") {
    await handlePaymentIntentSucceeded({ id: paymentIntentId } as Stripe.PaymentIntent);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const payment = await queryOne<any>(
    `SELECT * FROM payments WHERE provider_payment_intent_id = ?`,
    [paymentIntent.id],
  );

  if (!payment) {
    return;
  }

  // Guard: avoid double-processing if checkout.session.completed already handled this payment
  const alreadyPaid = payment.status === "paid";

  let invoice: any = null;

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE payments
          SET status = 'paid',
              paid_at = COALESCE(paid_at, NOW()),
              provider_payment_intent_id = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [paymentIntent.id, payment.id],
    );

    invoice = await createInvoiceForPayment(connection, {
      paymentId: payment.id,
      userId: payment.user_id,
      subtotalCents: payment.amount_cents,
      taxCents: payment.tax_amount_cents,
      totalCents: payment.total_amount_cents,
      currency: payment.currency,
      billingName: null,
    });

    if (payment.related_entity_type === "request" && payment.related_entity_id) {
      const [requestRows] = await connection.query<any[]>(
        `SELECT * FROM requests WHERE id = ?`,
        [payment.related_entity_id],
      );
      const request = (requestRows as any[])[0];

      if (request) {
        await publishRequest(connection, request);
      }
    }
  });

  if (alreadyPaid) {
    return;
  }

  const fmt = new Intl.NumberFormat("fr-CA", { style: "currency", currency: payment.currency ?? "CAD" });
  const montant = fmt.format((payment.total_amount_cents ?? payment.amount_cents ?? 0) / 100);
  const generatedInvoice: any = invoice;
  const receiptLine = generatedInvoice
    ? `\n\nRecu n° ${generatedInvoice.invoice_number} joint en piece attachee.`
    : "";

  await createInAppNotification(
    null,
    payment.user_id,
    "request_publication_payment_succeeded",
    "Paiement de publication confirme",
    `Le paiement de publication de votre demande (${montant}) a bien ete confirme. Votre demande est maintenant publiee.`,
  );

  // Email unique : confirmation + statut publié + reçu PDF joint
  await sendEventEmail({
    userId: payment.user_id,
    type: "request_publication_payment_succeeded",
    title: "Paiement de publication confirme",
    body: `Le paiement de publication de votre demande a bien ete confirme.\n\nMontant regle : ${montant}\n\nVotre demande est maintenant publiee et visible par les prestataires.${receiptLine}`,
    ...(generatedInvoice ? {
      attachments: [
        {
          filename: `${generatedInvoice.invoice_number}.pdf`,
          path: generatedInvoice.pdf_path ?? undefined,
          url: generatedInvoice.pdf_url ?? undefined,
          contentType: "application/pdf",
        },
      ],
    } : {}),
  });

  if (generatedInvoice) {
    await createInAppNotification(
      null,
      payment.user_id,
      "invoice_available",
      "Recu disponible",
      `Votre recu ${generatedInvoice.invoice_number} est disponible.`,
    );
  }
}

async function hasProcessedStripeEvent(eventId: string) {
  return (
    (await queryOne(
      `SELECT id
         FROM audit_logs
        WHERE entity_type = 'stripe_event'
          AND entity_id = ?
          AND action = 'processed'
        LIMIT 1`,
      [eventId],
    )) !== null
  );
}

async function markStripeEventProcessed(event: Stripe.Event) {
  await withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO audit_logs (id, actor_user_id, entity_type, entity_id, action, old_values_json, new_values_json, ip_address)
       VALUES (?, NULL, 'stripe_event', ?, 'processed', NULL, ?, NULL)`,
      [createId("audit"), event.id, JSON.stringify({ type: event.type, created: event.created })],
    );
  });
}

async function syncSubscriptionFromStripeSubscription(subscription: Stripe.Subscription) {
  const localStatus = mapStripeSubscriptionStatus(subscription.status);
  const currentPeriodEnd = resolveStripePeriodEnd(subscription);
  const localSubscriptionId =
    subscription.metadata?.local_subscription_id ??
    (
      await queryOne<{ id: string }>(
        `SELECT id
           FROM subscriptions
          WHERE stripe_subscription_id = ?
          LIMIT 1`,
        [subscription.id],
      )
    )?.id;

  if (!localSubscriptionId) {
    return;
  }

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE subscriptions
          SET stripe_subscription_id = ?,
              status = ?,
              starts_at = COALESCE(starts_at, FROM_UNIXTIME(?)),
              ends_at = CASE WHEN ? IS NULL THEN NULL ELSE FROM_UNIXTIME(?) END,
              cancel_at_period_end = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [
        subscription.id,
        localStatus,
        subscription.start_date,
        currentPeriodEnd,
        currentPeriodEnd,
        subscription.cancel_at_period_end ? 1 : 0,
        localSubscriptionId,
      ],
    );
  });
}

async function ensureSubscriptionCheckoutPaymentRecorded(session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription" || !session.subscription) {
    return;
  }

  const stripeSubscription =
    typeof session.subscription === "string"
      ? await getStripeClient().subscriptions.retrieve(session.subscription)
      : session.subscription;

  await syncSubscriptionFromStripeSubscription(stripeSubscription);

  const localSubscriptionId =
    stripeSubscription.metadata?.local_subscription_id ??
    session.metadata?.local_subscription_id ??
    null;
  const userId = stripeSubscription.metadata?.user_id ?? session.metadata?.user_id ?? null;

  if (!localSubscriptionId || !userId) {
    return;
  }

  const latestInvoice: StripeInvoiceLike | null =
    typeof stripeSubscription.latest_invoice === "string"
      ? ((await getStripeClient().invoices.retrieve(stripeSubscription.latest_invoice, {
          expand: ["payment_intent"],
        })) as StripeInvoiceLike)
      : ((stripeSubscription.latest_invoice as StripeInvoiceLike | null) ?? null);


  if (latestInvoice?.status !== "paid") {
    return;
  }

  await handleSubscriptionInvoicePaid(latestInvoice);
}

async function handleSubscriptionInvoicePaid(invoice: StripeInvoiceLike) {
  const stripeSubscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  const paymentIntentId = typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent?.id;

  if (!stripeSubscriptionId) {
    return;
  }

  const subscription = await queryOne<{
    id: string;
    user_id: string;
    stripe_subscription_id: string | null;
  }>(
    `SELECT id, user_id, stripe_subscription_id
       FROM subscriptions
      WHERE stripe_subscription_id = ?
      LIMIT 1`,
    [stripeSubscriptionId],
  );

  const stripeSubscription = await getStripeClient().subscriptions.retrieve(stripeSubscriptionId);
  await syncSubscriptionFromStripeSubscription(stripeSubscription);
  const currentPeriodEnd = resolveStripePeriodEnd(stripeSubscription, invoice);

  const localSubscription =
    subscription ??
    (await queryOne<{
      id: string;
      user_id: string;
      stripe_subscription_id: string | null;
    }>(
      `SELECT id, user_id, stripe_subscription_id
         FROM subscriptions
        WHERE id = ?
        LIMIT 1`,
      [stripeSubscription.metadata?.local_subscription_id ?? ""],
    ));

  const planInfo = localSubscription
    ? await queryOne<{ name: string; price_cents: number; currency: string }>(
        `SELECT p.name, p.price_cents, p.currency
           FROM plans p
           JOIN subscriptions s ON s.plan_id = p.id
          WHERE s.id = ?`,
        [localSubscription.id],
      )
    : null;

  if (!localSubscription) {
    return;
  }

  const hasPreviousPaidPayment = !!(await queryOne(
    `SELECT id FROM payments
      WHERE related_entity_type = 'subscription'
        AND related_entity_id = ?
        AND status = 'paid'
      LIMIT 1`,
    [localSubscription.id],
  ));
  const isFirstPayment = !hasPreviousPaidPayment;

  let invoiceRecord: any = null;
  let createdPayment = false;
  const subtotalCents = invoice.subtotal ?? Math.max((invoice.total ?? 0) - (invoice.tax ?? 0), 0);
  const taxCents = invoice.tax ?? Math.max((invoice.total ?? 0) - subtotalCents, 0);
  const totalCents = invoice.total ?? subtotalCents + taxCents;

  await withTransaction(async (connection) => {
    const paymentLookupSql = paymentIntentId
      ? `SELECT * FROM payments WHERE provider_payment_intent_id = ? LIMIT 1`
      : `SELECT * FROM payments WHERE provider_checkout_session_id = ? LIMIT 1`;
    const paymentLookupValue = paymentIntentId ?? invoice.id;
    const [paymentRows] = await connection.query<any[]>(
      paymentLookupSql,
      [paymentLookupValue],
    );
    const existingPayment = (paymentRows as any[])[0] ?? null;
    const paymentId = existingPayment?.id ?? createId("pay");
    const paidAtUnix = invoice.status_transitions?.paid_at ?? null;

    if (existingPayment) {
      await connection.execute(
        `UPDATE payments
            SET payment_type = 'provider_subscription',
                related_entity_type = 'subscription',
                related_entity_id = ?,
                amount_cents = ?,
                tax_amount_cents = ?,
                total_amount_cents = ?,
                currency = ?,
                provider = 'stripe',
                provider_checkout_session_id = COALESCE(provider_checkout_session_id, ?),
                status = 'paid',
                paid_at = COALESCE(paid_at, CASE WHEN ? IS NULL THEN NOW() ELSE FROM_UNIXTIME(?) END),
                updated_at = NOW()
          WHERE id = ?`,
        [
          localSubscription.id,
          subtotalCents,
          taxCents,
          totalCents,
          (invoice.currency ?? "cad").toUpperCase(),
          invoice.id,
          paidAtUnix,
          paidAtUnix,
          paymentId,
        ],
      );
    } else {
      createdPayment = true;
      await connection.execute(
        `INSERT INTO payments (
          id, user_id, payment_type, related_entity_type, related_entity_id,
          amount_cents, tax_amount_cents, total_amount_cents, currency, provider,
          provider_payment_intent_id, provider_checkout_session_id, status, paid_at
        ) VALUES (?, ?, 'provider_subscription', 'subscription', ?, ?, ?, ?, ?, 'stripe', ?, ?, 'paid',
          CASE WHEN ? IS NULL THEN NOW() ELSE FROM_UNIXTIME(?) END)`,
        [
          paymentId,
          localSubscription.user_id,
          localSubscription.id,
          subtotalCents,
          taxCents,
          totalCents,
          (invoice.currency ?? "cad").toUpperCase(),
          paymentIntentId ?? null,
          invoice.id,
          paidAtUnix,
          paidAtUnix,
        ],
      );
    }

    invoiceRecord = await createInvoiceForPayment(connection, {
      paymentId,
      userId: localSubscription.user_id,
      subtotalCents,
      taxCents,
      totalCents,
      currency: (invoice.currency ?? "cad").toUpperCase(),
      billingName: invoice.customer_name ?? null,
    });

    if (currentPeriodEnd != null) {
      await connection.execute(
        `UPDATE subscriptions
            SET ends_at = FROM_UNIXTIME(?),
                updated_at = NOW()
          WHERE id = ?`,
        [currentPeriodEnd, localSubscription.id],
      );
    }
  });

  if (createdPayment) {
    const notifType = isFirstPayment ? "subscription_created" : "subscription_renewed";
    const notifTitle = isFirstPayment ? "Abonnement active" : "Paiement d'abonnement confirme";
    const planCurrency = planInfo?.currency ?? invoice.currency ?? "cad";
    const fmt = new Intl.NumberFormat("fr-CA", { style: "currency", currency: planCurrency.toUpperCase() });
    const montant = fmt.format(totalCents / 100);
    const planName = planInfo?.name ? ` — formule ${planInfo.name}` : "";
    const receiptLine = invoiceRecord
      ? `\n\nRecu n° ${invoiceRecord.invoice_number} joint en piece attachee.`
      : "";
    const notifBody = isFirstPayment
      ? `Votre abonnement est maintenant actif${planName}. Montant regle : ${montant}. Bienvenue !`
      : `Votre paiement d'abonnement a bien ete confirme${planName}. Montant regle : ${montant}.`;

    await createInAppNotification(null, localSubscription.user_id, notifType, notifTitle, notifBody);

    // Email unique : confirmation + recu PDF en piece jointe
    await sendEventEmail({
      userId: localSubscription.user_id,
      type: notifType,
      title: notifTitle,
      body: `${notifBody}${receiptLine}`,
      ...(invoiceRecord ? {
        attachments: [
          {
            filename: `${invoiceRecord.invoice_number}.pdf`,
            path: invoiceRecord.pdf_path ?? undefined,
            url: invoiceRecord.pdf_url ?? undefined,
            contentType: "application/pdf",
          },
        ],
      } : {}),
    });
  }

  // Notification in-app pour la disponibilite du recu
  if (invoiceRecord) {
    await createInAppNotification(
      null,
      localSubscription.user_id,
      "invoice_available",
      "Recu disponible",
      `Votre recu ${invoiceRecord.invoice_number} est disponible.`,
    );
  }
}

function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status) {
  switch (status) {
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "cancelled";
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
      return "inactive";
    case "paused":
      return "expired";
    default:
      return "inactive";
  }
}

export function webhooksRouter() {
  const router = Router();

  router.post(
    "/webhooks/stripe",
    asyncHandler(async (req, res) => {
      const signature = req.header("stripe-signature");

      if (!signature) {
        throw new ApiError(400, "STRIPE_SIGNATURE_MISSING", "Missing Stripe signature");
      }

      const event = getStripeClient().webhooks.constructEvent(
        req.body as Buffer,
        signature,
        getStripeWebhookSecret(),
      );

      if (await hasProcessedStripeEvent(event.id)) {
        return ok(res, { received: true, type: event.type, duplicate: true });
      }

      switch (event.type) {
        case "payment_intent.succeeded":
          await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        case "payment_intent.payment_failed":
        case "payment_intent.canceled":
          await markPaymentFailed((event.data.object as Stripe.PaymentIntent).id);
          break;
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode === "subscription") {
            await ensureSubscriptionCheckoutPaymentRecorded(session);
          } else if (session.mode === "payment") {
            await handlePublicationCheckoutCompleted(session);
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          await syncSubscriptionFromStripeSubscription(event.data.object as Stripe.Subscription);
          break;
        case "invoice.paid":
          await handleSubscriptionInvoicePaid(event.data.object as Stripe.Invoice);
          break;
        default:
          break;
      }

      await markStripeEventProcessed(event);

      return ok(res, { received: true, type: event.type });
    }),
  );

  return router;
}
