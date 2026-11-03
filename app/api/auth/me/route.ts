import { route } from "@/lib/server/http";

export const GET = route(async ({ actor }) => ({ actor: { id: actor.id, name: actor.name, roles: actor.roles, tenant: actor.tenantName, organization: actor.organizationName, providerId: actor.providerId } }));
