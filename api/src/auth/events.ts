/** Emitted after sign-in credentials stop being valid, so live connections can be closed. */
export const AuthEvents = {
  credentialsRevoked: 'auth.credentials_revoked',
} as const;

export interface CredentialsRevokedEvent {
  /** One credential: `session:<id>` or `token:<id>`. */
  credentialId?: string;
  /** Every credential of this user (except `exceptCredentialId`). */
  userId?: string;
  exceptCredentialId?: string;
}

export const sessionCredentialId = (sessionId: string) => `session:${sessionId}`;
export const tokenCredentialId = (tokenId: string) => `token:${tokenId}`;
