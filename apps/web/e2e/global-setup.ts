import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

import { E2eIdp } from "./support/idp";
import { seed } from "./support/seed";
import { type E2eState, STATE_FILE } from "./support/state";

const ROLE_PASSWORD = "estatepro-e2e";
const ROLES = [
  "estatepro_app",
  "estatepro_auth",
  "estatepro_platform",
  "estatepro_web",
] as const;

const webDir = join(import.meta.dirname, "..");
const apiDir = join(webDir, "..", "api");
const migrationsDir = join(webDir, "..", "..", "database", "migrations");

/**
 * End-to-end environment: a fresh database from every migration, the test
 * identity provider, the API and worker (built output), and the production
 * build of the web app. Everything runs on loopback.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = new URL(
    process.env["E2E_DATABASE_ADMIN_URL"] ??
      "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  );
  const databaseName = process.env["E2E_DATABASE_NAME"] ?? "estatepro_web_e2e";
  const apiPort = Number(process.env["E2E_API_PORT"] ?? 3201);
  const idpPort = Number(process.env["E2E_IDP_PORT"] ?? 3202);
  const webPort = Number(process.env["E2E_WEB_PORT"] ?? 3100);
  const storage = {
    endpoint: process.env["E2E_STORAGE_ENDPOINT"] ?? "http://127.0.0.1:8333",
    bucket: process.env["E2E_STORAGE_BUCKET"] ?? "estatepro-test-media",
    accessKeyId: process.env["E2E_STORAGE_ACCESS_KEY_ID"] ?? "estatepro-test",
    secretAccessKey:
      process.env["E2E_STORAGE_SECRET_ACCESS_KEY"] ?? "estatepro-test-secret",
  };

  for (const port of [apiPort, idpPort, webPort]) {
    if (await listening(`http://127.0.0.1:${port}/`)) throw new Error(`Port ${port} is already in use; stop the process from an earlier run first.`);
  }

  const server = new pg.Client({ connectionString: adminUrl.toString() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${databaseName}`);
  await server.end();
  const databaseAdminUrl = new URL(adminUrl);
  databaseAdminUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({
    connectionString: databaseAdminUrl.toString(),
  });
  await admin.connect();
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await admin.query(readFileSync(join(migrationsDir, file), "utf8"));
  }
  for (const role of ROLES)
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${ROLE_PASSWORD}'`);
  await admin.end();
  const roleUrl = (role: string): string => {
    const url = new URL(databaseAdminUrl);
    url.username = role;
    url.password = ROLE_PASSWORD;
    return url.toString();
  };

  const idp = new E2eIdp();
  await idp.start(idpPort);
  const children: ChildProcess[] = [];
  const stop = async () => {
    for (const child of children) child.kill("SIGTERM");
    await idp.stop();
  };
  try {
    if (
      !existsSync(join(apiDir, "dist", "main.js")) ||
      process.env["E2E_BUILD_API"] === "1"
    ) {
      execFileSync("pnpm", ["run", "build"], { cwd: apiDir, stdio: "inherit" });
    }
    const apiEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(apiPort),
      LOG_LEVEL: process.env["E2E_API_LOG_LEVEL"] ?? "warn",
      DATABASE_URL: roleUrl("estatepro_app"),
      AUTH_DATABASE_URL: roleUrl("estatepro_auth"),
      PLATFORM_DATABASE_URL: roleUrl("estatepro_platform"),
      OIDC_ISSUER: idp.issuer,
      OIDC_AUDIENCE: idp.audience,
      OIDC_JWKS_URL: `${idp.issuer}/jwks.json`,
      OIDC_PROVIDER: "e2e-idp",
      STORAGE_ENDPOINT: storage.endpoint,
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: storage.bucket,
      STORAGE_ACCESS_KEY_ID: storage.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: storage.secretAccessKey,
      STORAGE_FORCE_PATH_STYLE: "true",
      CLAMAV_HOST: process.env["E2E_CLAMAV_HOST"] ?? "127.0.0.1",
      CLAMAV_PORT: process.env["E2E_CLAMAV_PORT"] ?? "3310",
    };
    children.push(start("api", "node", ["dist/main.js"], apiDir, apiEnv));
    children.push(
      start("worker", "node", ["dist/worker/main.js"], apiDir, apiEnv),
    );
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitFor(`${apiUrl}/health`, 60_000);

    const webUrl = `http://127.0.0.1:${webPort}`;
    const webEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      WEB_ORIGIN: webUrl,
      API_BASE_URL: apiUrl,
      WEB_DATABASE_URL: roleUrl("estatepro_web"),
      WEB_SESSION_KEY: randomBytes(32).toString("base64"),
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      OIDC_AUDIENCE: idp.audience,
      OIDC_ALLOW_INSECURE: "true",
      MEDIA_ORIGIN: new URL(storage.endpoint).origin,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    if (
      process.env["E2E_REUSE_BUILD"] !== "1" ||
      !existsSync(join(webDir, ".next", "BUILD_ID"))
    ) {
      execFileSync("pnpm", ["exec", "next", "build"], {
        cwd: webDir,
        stdio: "inherit",
        env: webEnv,
      });
    }
    children.push(
      start(
        "web",
        process.execPath,
        [
          join(webDir, "node_modules", "next", "dist", "bin", "next"),
          "start",
          "--port",
          String(webPort),
          "--hostname",
          "127.0.0.1",
        ],
        webDir,
        webEnv,
      ),
    );
    await waitFor(`${webUrl}/sign-in`, 60_000);

    const seeded = await seed({
      apiUrl,
      idp,
      platformDatabaseUrl: roleUrl("estatepro_platform"),
      adminDatabaseUrl: databaseAdminUrl.toString(),
    });
    const state: E2eState = {
      webUrl,
      apiUrl,
      idpUrl: idp.issuer,
      adminDatabaseUrl: databaseAdminUrl.toString(),
      ...seeded,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
}

function start(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const verbose = process.env["E2E_VERBOSE"] === "1";
  child.stdout?.on("data", (chunk: Buffer) => {
    if (verbose) process.stdout.write(`[${name}] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) =>
    process.stderr.write(`[${name}] ${chunk.toString()}`),
  );
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM")
      process.stderr.write(`[${name}] exited with ${code ?? signal}\n`);
  });
  return child;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not start within ${timeoutMs} ms`);
}

async function listening(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}
