import { db } from "./db";

// The identity comes from the authenticated database session. Email alone is
// insufficient to claim purchases until control of that address is verified.
export async function resolveCustomerForIdentity(tenantId: string, userId: string) {
  const linked = await db.customer.findFirst({ where: { tenantId, userId } });
  if (linked) return linked;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email || !user.emailVerified) return null;

  const customer = await db.customer.findUnique({
    where: { tenantId_normalizedEmail: { tenantId, normalizedEmail: user.email.trim().toLowerCase() } },
  });
  if (!customer || (customer.userId && customer.userId !== userId)) return null;

  // Compare-and-set prevents two claims from overwriting a concurrent link.
  await db.customer.updateMany({
    where: { id: customer.id, tenantId, userId: null },
    data: { userId },
  });
  return db.customer.findFirst({ where: { id: customer.id, tenantId, userId } });
}
