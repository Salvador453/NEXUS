import pg from "pg";
const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT 'NEXUS user', created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('income','expense')), amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
      category TEXT NOT NULL, note TEXT DEFAULT '', occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shift_date DATE NOT NULL, status TEXT NOT NULL DEFAULT 'worked' CHECK(status IN ('worked','day_off','planned')),
      hours NUMERIC(6,2) DEFAULT 0, pay_type TEXT NOT NULL DEFAULT 'per_shift',
      amount NUMERIC(12,2) DEFAULT 0, note TEXT DEFAULT '',
      UNIQUE(user_id, shift_date)
    );
    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, target NUMERIC(12,2) NOT NULL, current NUMERIC(12,2) NOT NULL DEFAULT 0,
      due_date DATE, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, remind_at TIMESTAMPTZ, done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
