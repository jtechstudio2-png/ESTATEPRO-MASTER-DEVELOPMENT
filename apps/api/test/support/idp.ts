import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, type JWK, SignJWT, type CryptoKey } from 'jose';

export interface TokenOptions {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  amr?: string[];
  authTime?: number;
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  notBeforeSeconds?: number;
  signWithForeignKey?: boolean;
  algorithm?: 'RS256' | 'ES256' | 'HS256';
  omitSubject?: boolean;
}

/**
 * A minimal OIDC token issuer for tests: real key pairs, real signatures and a
 * JWKS endpoint over HTTP, so the API's verification path runs unchanged.
 */
export class TestIdp {
  readonly issuer = 'https://idp.test.estatepro.invalid/';
  readonly audience = 'estatepro-api-test';
  readonly provider = 'test-idp';

  private server!: Server;
  private rsaKey!: CryptoKey;
  private ecKey!: CryptoKey;
  private foreignKey!: CryptoKey;
  private jwks: JWK[] = [];
  jwksUrl = '';

  async start(): Promise<void> {
    const rsa = await generateKeyPair('RS256');
    const ec = await generateKeyPair('ES256');
    const foreign = await generateKeyPair('RS256');
    this.rsaKey = rsa.privateKey;
    this.ecKey = ec.privateKey;
    this.foreignKey = foreign.privateKey;
    this.jwks = [
      { ...(await exportJWK(rsa.publicKey)), kid: 'rsa-1', alg: 'RS256', use: 'sig' },
      { ...(await exportJWK(ec.publicKey)), kid: 'ec-1', alg: 'ES256', use: 'sig' },
    ];

    this.server = createServer((req, res) => {
      if (req.url === '/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: this.jwks }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.jwksUrl = `http://127.0.0.1:${port}/jwks.json`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  async token(options: TokenOptions): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (options.email !== undefined) claims['email'] = options.email;
    if (options.emailVerified !== undefined) claims['email_verified'] = options.emailVerified;
    if (options.amr !== undefined) claims['amr'] = options.amr;
    if (options.authTime !== undefined) claims['auth_time'] = options.authTime;

    const algorithm = options.algorithm ?? 'RS256';
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: algorithm, kid: algorithm === 'ES256' ? 'ec-1' : 'rsa-1' })
      .setIssuer(options.issuer ?? this.issuer)
      .setAudience(options.audience ?? this.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresInSeconds ?? 300));
    if (!options.omitSubject) jwt.setSubject(options.sub);
    if (options.notBeforeSeconds !== undefined) jwt.setNotBefore(now + options.notBeforeSeconds);

    if (algorithm === 'HS256') return jwt.sign(new TextEncoder().encode('a-shared-secret-that-must-be-rejected'));
    if (algorithm === 'ES256') return jwt.sign(this.ecKey);
    return jwt.sign(options.signWithForeignKey ? this.foreignKey : this.rsaKey);
  }
}
