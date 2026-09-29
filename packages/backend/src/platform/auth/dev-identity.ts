import { createVerifiedIdentity } from "./verified-identity.js";

export const getDevIdentity = () =>
  createVerifiedIdentity({
    provider: "dev",
    issuer: "urn:starter:dev",
    subject: "local-developer",
    email: "developer@starter.local",
    displayName: "Local Developer",
    // どの判断にも使っていない。v0.2 で RBAC を入れるときの見本値。
    roles: ["projects:read", "projects:write"],
  });
