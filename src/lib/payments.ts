import type { Prisma } from "@prisma/client";

import { assertCheckoutPaymentMatches, type CheckoutPaymentEvidence } from "./payment-policy";
import { db } from "@/lib/db";

async function paymentTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, tx?: Prisma.TransactionClient) {
  return tx ? operation(tx) : db.$transaction(operation);
}

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  // All payment state transitions serialize on the same row, including webhook retries.
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
}

export function normalizeCustomerEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function markOrderPaid(input: {
  orderId: string;
  email: string;
  customerName?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
  checkoutEvidence?: CheckoutPaymentEvidence;
}, transaction?: Prisma.TransactionClient) {
  const normalizedEmail = normalizeCustomerEmail(input.email);

  return paymentTransaction(async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: {
        items: { include: { deliverableAssets: true } },
        payments: true,
      },
    });
    if (!order) throw new Error("Order not found.");

    if (input.checkoutEvidence) assertCheckoutPaymentMatches(order, input.checkoutEvidence);
    if (order.stripePaymentIntentId && order.stripePaymentIntentId !== input.stripePaymentIntentId) {
      throw new Error("Payment intent does not match order.");
    }
    // Replays must not change the buyer, payment state, or revoked rights.
    if (["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.status)) {
      if (order.buyerEmail && normalizeCustomerEmail(order.buyerEmail) !== normalizedEmail) {
        throw new Error("Paid order customer does not match.");
      }
      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { customer: true, items: { include: { purchaseLicense: true } }, payments: true },
      });
    }

    const customer = await tx.customer.upsert({
      where: {
        tenantId_normalizedEmail: {
          tenantId: order.tenantId,
          normalizedEmail,
        },
      },
      update: {
        email: input.email,
        name: input.customerName ?? undefined,
        stripeCustomerId: input.stripeCustomerId ?? undefined,
      },
      create: {
        tenantId: order.tenantId,
        email: input.email,
        normalizedEmail,
        name: input.customerName ?? null,
        stripeCustomerId: input.stripeCustomerId ?? null,
      },
    });

    if (order.status !== "PAID") {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PAID",
          customerId: customer.id,
          buyerEmail: input.email,
          stripePaymentIntentId: input.stripePaymentIntentId ?? undefined,
          paidAt: new Date(),
          failedAt: null,
          canceledAt: null,
        },
      });
    } else if (order.customerId !== customer.id || !order.buyerEmail) {
      await tx.order.update({
        where: { id: order.id },
        data: { customerId: customer.id, buyerEmail: input.email },
      });
    }

    const payment = order.payments[0];
    if (payment) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCEEDED",
          providerPaymentId: input.stripePaymentIntentId ?? undefined,
          failureCode: null,
          failureMessage: null,
        },
      });
    }

    for (const item of order.items) {
      const purchaseLicense = await tx.purchaseLicense.upsert({
        where: { orderItemId: item.id },
        update: {},
        create: {
          tenantId: order.tenantId,
          orderId: order.id,
          orderItemId: item.id,
          customerId: customer.id,
          licenseVersionId: item.licenseVersionId,
          acceptedAt: order.termsAcceptedAt,
          termsTextSnapshot: item.termsTextSnapshot,
        },
      });

      for (const asset of item.deliverableAssets) {
        await tx.downloadEntitlement.upsert({
          where: {
            purchaseLicenseId_audioAssetId: {
              purchaseLicenseId: purchaseLicense.id,
              audioAssetId: asset.audioAssetId,
            },
          },
          update: {},
          create: {
            tenantId: order.tenantId,
            purchaseLicenseId: purchaseLicense.id,
            audioAssetId: asset.audioAssetId,
            fileNameSnapshot: asset.fileNameSnapshot,
          },
        });
      }
    }

    return tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        customer: true,
        items: { include: { purchaseLicense: true } },
        payments: true,
      },
    });
  }, transaction);
}

export async function markOrderPaymentFailed(input: {
  orderId: string;
  stripePaymentIntentId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}, transaction?: Prisma.TransactionClient) {
  return paymentTransaction(async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { payments: true },
    });
    if (!order) throw new Error("Order not found.");
    if (["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "CANCELED"].includes(order.status)) return order;
    if (order.stripePaymentIntentId && order.stripePaymentIntentId !== input.stripePaymentIntentId) {
      throw new Error("Payment intent does not match order.");
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "PAYMENT_FAILED",
        failedAt: new Date(),
        stripePaymentIntentId: input.stripePaymentIntentId ?? undefined,
      },
    });

    const payment = order.payments[0];
    if (payment) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          providerPaymentId: input.stripePaymentIntentId ?? undefined,
          failureCode: input.failureCode ?? null,
          failureMessage: input.failureMessage ?? null,
        },
      });
    }

    return tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true },
    });
  }, transaction);
}

export async function recordRefund(input: {
  orderId: string;
  providerRefundId: string;
  stripePaymentIntentId?: string | null;
  amountCents: number;
  reason?: string | null;
}, transaction?: Prisma.TransactionClient) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Refund amount must be a positive integer.");
  }

  return paymentTransaction(async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { payments: { include: { refunds: true } } },
    });
    if (!order) throw new Error("Order not found.");
    const payment = order.payments[0];
    if (!payment) throw new Error("Order payment not found.");
    if (input.stripePaymentIntentId && order.stripePaymentIntentId !== input.stripePaymentIntentId) {
      throw new Error("Refund payment intent does not match order.");
    }

    if (!["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.status)) {
      throw new Error("Cannot refund an unpaid order.");
    }
    const prior = await tx.refund.findUnique({ where: { providerRefundId: input.providerRefundId } });
    if (prior && (prior.paymentId !== payment.id || prior.amountCents !== input.amountCents)) {
      throw new Error("Refund does not match the recorded payment.");
    }
    const previousTotal = payment.refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
    if (!prior && previousTotal + input.amountCents > payment.amountCents) {
      throw new Error("Refund total exceeds the payment amount.");
    }
    await tx.refund.upsert({
      where: { providerRefundId: input.providerRefundId },
      update: {},
      create: {
        paymentId: payment.id,
        providerRefundId: input.providerRefundId,
        amountCents: input.amountCents,
        status: "REFUNDED",
        reason: input.reason ?? null,
      },
    });

    const refunds = await tx.refund.findMany({ where: { paymentId: payment.id } });
    const refundedCents = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
    const fullRefund = refundedCents >= payment.amountCents && payment.amountCents > 0;

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedCents,
        status: fullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED",
      },
    });

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: fullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED",
        refundedAt: fullRefund ? new Date() : null,
      },
    });

    if (fullRefund) {
      await tx.purchaseLicense.updateMany({
        where: {
          orderId: order.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revocationReason: "Order fully refunded.",
        },
      });
    }

    return tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: { include: { refunds: true } } },
    });
  }, transaction);
}
