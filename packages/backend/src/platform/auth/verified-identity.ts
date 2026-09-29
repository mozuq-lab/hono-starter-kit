import { authenticatedUserSchema } from "@starter/contracts";
import type { VerifiedIdentity } from "./auth.model.js";

export type VerifiedIdentityInput = Omit<
  VerifiedIdentity,
  "email" | "displayName" | "roles"
> & {
  email?: unknown;
  displayName?: unknown;
  roles: readonly string[];
};

export const createVerifiedIdentity = ({
  email,
  displayName,
  roles,
  ...required
}: VerifiedIdentityInput): VerifiedIdentity => {
  const parsedEmail = authenticatedUserSchema.shape.email.safeParse(email);
  const parsedDisplayName =
    authenticatedUserSchema.shape.displayName.safeParse(displayName);
  const parsedRoles = authenticatedUserSchema.shape.roles.parse([...roles]);

  return {
    ...required,
    roles: [...parsedRoles],
    ...(parsedEmail.success && parsedEmail.data !== undefined
      ? { email: parsedEmail.data }
      : {}),
    ...(parsedDisplayName.success && parsedDisplayName.data !== undefined
      ? { displayName: parsedDisplayName.data }
      : {}),
  };
};
