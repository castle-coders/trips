import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export type Env = {
  Bindings: {
    DB: D1Database;
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUDIENCE: string;
    BOOTSTRAP_ADMIN_EMAIL?: string;
    DEV_MODE?: string;
  };
  Variables: {
    user: AuthUser;
  };
};

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
