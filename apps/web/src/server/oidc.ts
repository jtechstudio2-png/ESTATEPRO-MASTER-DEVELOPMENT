import 'server-only';

import * as client from 'openid-client';

import { env } from './env';

export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  stepUp: boolean;
}

export interface TokenSet {
  subject: string;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accessExpiresAt: Date;
}

/** Access-token lifetime assumed when the provider does not say (seconds). */
const DEFAULT_TOKEN_SECONDS = 300;

let configuration: Promise<client.Configuration> | null = null;

/** OIDC discovery, cached for the process; retried on the next call if it fails. */
export function oidcConfiguration(): Promise<client.Configuration> {
  if (configuration === null) {
    const settings = env();
    const auth = settings.OIDC_CLIENT_SECRET === undefined ? client.None() : client.ClientSecretPost(settings.OIDC_CLIENT_SECRET);
    configuration = client
      .discovery(new URL(settings.OIDC_ISSUER), settings.OIDC_CLIENT_ID, settings.OIDC_CLIENT_SECRET, auth, {
        execute: settings.OIDC_ALLOW_INSECURE ? [client.allowInsecureRequests] : [],
      })
      .catch((error: unknown) => {
        configuration = null;
        throw error;
      });
  }
  return configuration;
}

export function redirectUri(): string {
  return `${env().WEB_ORIGIN}/auth/callback`;
}

/** Authorization Code flow with PKCE (S256), state and nonce. */
export async function startLogin(returnTo: string, stepUp: boolean): Promise<{ url: URL; transaction: LoginTransaction }> {
  const config = await oidcConfiguration();
  const settings = env();
  const transaction: LoginTransaction = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
    returnTo,
    stepUp,
  };
  const parameters: Record<string, string> = {
    redirect_uri: redirectUri(),
    scope: settings.OIDC_SCOPES,
    code_challenge: await client.calculatePKCECodeChallenge(transaction.codeVerifier),
    code_challenge_method: 'S256',
    state: transaction.state,
    nonce: transaction.nonce,
  };
  if (settings.OIDC_AUDIENCE !== undefined) parameters['audience'] = settings.OIDC_AUDIENCE;
  // Step-up: force a fresh sign-in so the provider asks for the second factor again.
  if (stepUp) {
    parameters['prompt'] = 'login';
    parameters['max_age'] = '0';
  }
  return { url: client.buildAuthorizationUrl(config, parameters), transaction };
}

export async function completeLogin(callbackUrl: URL, transaction: LoginTransaction): Promise<TokenSet> {
  const config = await oidcConfiguration();
  const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: transaction.codeVerifier,
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    idTokenExpected: true,
    ...(transaction.stepUp ? { maxAge: 0 } : {}),
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new Error('The identity provider returned no subject.');
  return toTokenSet(claims.sub, tokens);
}

export async function refreshTokens(subject: string, refreshToken: string, previousIdToken: string | null): Promise<TokenSet> {
  const config = await oidcConfiguration();
  const tokens = await client.refreshTokenGrant(config, refreshToken);
  const set = toTokenSet(subject, tokens, refreshToken);
  return { ...set, idToken: set.idToken ?? previousIdToken };
}

/** The provider's sign-out URL, or null when it has none. */
export async function endSessionUrl(idToken: string | null): Promise<URL | null> {
  const config = await oidcConfiguration();
  if (config.serverMetadata().end_session_endpoint === undefined) return null;
  const parameters: Record<string, string> = { post_logout_redirect_uri: `${env().WEB_ORIGIN}/sign-in?signedOut=1` };
  if (idToken !== null) parameters['id_token_hint'] = idToken;
  return client.buildEndSessionUrl(config, parameters);
}

function toTokenSet(subject: string, tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers, previousRefresh: string | null = null): TokenSet {
  const expiresIn = tokens.expiresIn() ?? DEFAULT_TOKEN_SECONDS;
  return {
    subject,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefresh,
    idToken: tokens.id_token ?? null,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}
