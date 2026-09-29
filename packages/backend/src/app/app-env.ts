import type { Actor, AuthenticatedUser } from "../platform/auth/auth.model.js";

export type AppEnv = {
  Variables: {
    requestId: string;
    actor: Actor;
    authenticatedUser: AuthenticatedUser;
  };
};
