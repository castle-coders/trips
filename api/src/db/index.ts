import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface CfIdentity {
  email: string;
  name: string;
}

export type Env = {
  Bindings: {
    DB: D1Database;
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUDIENCE: string;
    BOOTSTRAP_ADMIN_EMAIL?: string;
    DEV_MODE?: string;
    EXTERNAL_EVAL_PRIVATE_KEY: string;
    EXTERNAL_EVAL_KEY_ID?: string;
  };
  Variables: {
    user: AuthUser;
    cfIdentity: CfIdentity;
  };
};

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
