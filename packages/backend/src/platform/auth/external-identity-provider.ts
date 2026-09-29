import type { VerifiedIdentity } from "./auth.model.js";

export interface ExternalIdentityProvider {
  begin(input: { redirectUri: string }): Promise<{
    authorizationUrl: string;
    state: string;
    nonce: string;
    verifier: string;
  }>;
  complete(input: {
    callbackUrl: URL;
    redirectUri: string;
    expectedState: string;
    expectedNonce: string;
    verifier: string;
  }): Promise<VerifiedIdentity>;
  logoutUrl(input: { postLogoutRedirectUri: string }): string;
}
