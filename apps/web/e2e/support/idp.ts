import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, type JWK, SignJWT, type CryptoKey } from 'jose';

interface PendingCode {
  email: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  authTime: number;
  mfa: boolean;
}

/**
 * A small OpenID Connect provider for end-to-end tests: discovery, an
 * authorisation page with an email field (like a real sign-in page), the
 * token endpoint with PKCE and refresh tokens, JWKS and end-session. Tokens
 * are real RS256 JWTs verified by the API unchanged.
 */
export class E2eIdp {
  readonly audience = 'estatepro-api-e2e';
  readonly clientId = 'estatepro-web-e2e';
  issuer = '';
  private server!: Server;
  private key!: CryptoKey;
  private jwk!: JWK;
  private readonly codes = new Map<string, PendingCode>();
  private readonly refreshTokens = new Map<string, Omit<PendingCode, 'codeChallenge' | 'redirectUri'>>();
  /** Lifetime of access tokens; short values exercise the web app's refresh. */
  accessTokenSeconds = 300;

  async start(port = 0): Promise<void> {
    const pair = await generateKeyPair('RS256');
    this.key = pair.privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'e2e-1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** An access token for seeding through the API (outside the browser). */
  accessToken(email: string, subject = subjectFor(email)): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ email, email_verified: true, amr: ['pwd', 'mfa'], auth_time: now })
      .setProtectedHeader({ alg: 'RS256', kid: 'e2e-1' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTokenSeconds)
      .sign(this.key);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks.json`,
        end_session_endpoint: `${this.issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (url.pathname === '/jwks.json') return json(res, 200, { keys: [this.jwk] });
    if (url.pathname === '/authorize' && req.method === 'GET') return this.authorizePage(url, res);
    if (url.pathname === '/authorize' && req.method === 'POST') return this.authorizeSubmit(await form(req), res);
    if (url.pathname === '/token' && req.method === 'POST') return this.token(await form(req), res);
    if (url.pathname === '/logout') {
      const target = url.searchParams.get('post_logout_redirect_uri');
      res.writeHead(target ? 302 : 200, target ? { location: target } : { 'content-type': 'text/plain' }).end(target ? undefined : 'Signed out');
      return;
    }
    res.writeHead(404).end();
  }

  private authorizePage(url: URL, res: ServerResponse): void {
    const params = url.searchParams;
    if (params.get('client_id') !== this.clientId || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid_request');
      return;
    }
    const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge', 'client_id']
      .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? '')}">`)
      .join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><title>Test sign-in</title></head><body>
<main><h1>Test identity provider</h1><form method="post" action="/authorize">${hidden}
<label for="email">Email</label> <input id="email" name="email" type="email" required>
<label><input type="checkbox" name="mfa" value="1" checked> Second factor</label>
<button type="submit">Continue</button></form></main></body></html>`);
  }

  private authorizeSubmit(body: URLSearchParams, res: ServerResponse): void {
    const code = randomBytes(24).toString('base64url');
    const redirectUri = body.get('redirect_uri') ?? '';
    this.codes.set(code, {
      email: (body.get('email') ?? '').toLowerCase(),
      clientId: body.get('client_id') ?? '',
      redirectUri,
      codeChallenge: body.get('code_challenge') ?? '',
      nonce: body.get('nonce') ?? '',
      authTime: Math.floor(Date.now() / 1000),
      mfa: body.get('mfa') === '1',
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', body.get('state') ?? '');
    target.searchParams.set('iss', this.issuer);
    res.writeHead(302, { location: target.toString() }).end();
  }

  private async token(body: URLSearchParams, res: ServerResponse): Promise<void> {
    let grant: Omit<PendingCode, 'codeChallenge' | 'redirectUri'>;
    if (body.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(body.get('code') ?? '');
      this.codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (
        !pending ||
        pending.clientId !== body.get('client_id') ||
        pending.redirectUri !== body.get('redirect_uri') ||
        createHash('sha256').update(verifier).digest('base64url') !== pending.codeChallenge
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      grant = pending;
    } else if (body.get('grant_type') === 'refresh_token') {
      const stored = this.refreshTokens.get(body.get('refresh_token') ?? '');
      if (!stored) return json(res, 400, { error: 'invalid_grant' });
      grant = stored;
    } else {
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const now = Math.floor(Date.now() / 1000);
    const subject = subjectFor(grant.email);
    const amr = grant.mfa ? ['pwd', 'mfa'] : ['pwd'];
    const accessToken = await new SignJWT({ email: grant.email, email_verified: true, amr, auth_time: grant.authTime })
      .setProtectedHeader({ alg: 'RS256', kid: 'e2e-1' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + this.accessTokenSeconds)
      .sign(this.key);
    const idToken = await new SignJWT({ email: grant.email, nonce: grant.nonce, auth_time: grant.authTime, amr })
      .setProtectedHeader({ alg: 'RS256', kid: 'e2e-1' })
      .setIssuer(this.issuer)
      .setAudience(grant.clientId)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(this.key);
    const refreshToken = randomBytes(24).toString('base64url');
    this.refreshTokens.set(refreshToken, grant);
    return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: this.accessTokenSeconds, id_token: idToken, refresh_token: refreshToken });
  }
}

export function subjectFor(email: string): string {
  return `e2e|${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24)}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
