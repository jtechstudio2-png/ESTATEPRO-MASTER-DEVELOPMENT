import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { DB } from './schema.js';

// PostgreSQL `date` values are business dates without a time zone: keep them as
// 'YYYY-MM-DD' strings instead of converting to a JavaScript Date in UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/**
 * Maps camelCase names to the schema's snake_case. Most columns with digits are
 * written without an underscore (`phone_e164`, `last4`), but address columns put
 * one before the number (`address_line_1`, `admin_area_1`); those are listed here.
 * JSON column contents keep their stored keys.
 */
export class SchemaCasePlugin extends CamelCasePlugin {
  static readonly digitSeparated = new Map<string, string>(
    ['address_line_1', 'address_line_2', 'address_line_3', 'admin_area_1', 'admin_area_2'].map((name) => [name.replace(/_(\d)/g, '$1'), name]),
  );

  constructor() {
    super({ maintainNestedObjectKeys: true });
  }

  protected override snakeCase(str: string): string {
    const snake = super.snakeCase(str);
    return SchemaCasePlugin.digitSeparated.get(snake) ?? snake;
  }
}

const APP_DB = Symbol('APP_DB');
const AUTH_DB = Symbol('AUTH_DB');

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

export function createKysely(connectionString: string, max: number, applicationName: string): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max, application_name: applicationName }),
    }),
    plugins: [new SchemaCasePlugin()],
  });
}

export interface TenantScope {
  companyId: string;
  userId: string;
}

/**
 * The only way request code obtains a database handle for company data.
 * Each call runs in its own transaction with the company and user set as
 * transaction-local settings, which the row-level security policies read.
 * If the settings were missing, RLS would return no rows (fail closed).
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  run<T>(scope: TenantScope, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select set_config('app.company_id', ${scope.companyId}, true), set_config('app.user_id', ${scope.userId}, true)`.execute(
        tx,
      );
      return work(tx);
    });
  }
}

/** Identity lookups across companies (estatepro_auth role). Used only by the auth module. */
@Injectable()
export class AuthDb {
  constructor(@Inject(AUTH_DB) readonly db: Db) {}
}

@Injectable()
export class DatabaseHealth {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  async check(): Promise<boolean> {
    try {
      await sql`select 1`.execute(this.db);
      return true;
    } catch {
      return false;
    }
  }
}

@Injectable()
class DatabaseLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(APP_DB) private readonly appDb: Db,
    @Inject(AUTH_DB) private readonly authDb: Db,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.appDb.destroy(), this.authDb.destroy()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: APP_DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createKysely(config.DATABASE_URL, config.DATABASE_POOL_MAX, 'estatepro-api'),
    },
    {
      provide: AUTH_DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createKysely(config.AUTH_DATABASE_URL, Math.max(2, Math.ceil(config.DATABASE_POOL_MAX / 2)), 'estatepro-api-auth'),
    },
    TenantDb,
    AuthDb,
    DatabaseHealth,
    DatabaseLifecycle,
  ],
  exports: [TenantDb, AuthDb, DatabaseHealth],
})
export class DatabaseModule {}
