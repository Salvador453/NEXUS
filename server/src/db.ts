import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

export async function initDb() {
  console.log("NEXUS: initializing database...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT 'NEXUS user',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
      category TEXT NOT NULL,
      note TEXT DEFAULT '',
      occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shift_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'worked'
        CHECK(status IN ('worked','day_off','planned')),
      hours NUMERIC(6,2) DEFAULT 0,
      pay_type TEXT NOT NULL DEFAULT 'per_shift',
      amount NUMERIC(12,2) DEFAULT 0,
      note TEXT DEFAULT '',
      UNIQUE(user_id, shift_date)
    );

    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      target NUMERIC(12,2) NOT NULL,
      current NUMERIC(12,2) NOT NULL DEFAULT 0,
      due_date DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      remind_at TIMESTAMPTZ,
      done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- WALLET SYSTEM

    CREATE TABLE IF NOT EXISTS wallets (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'cash'
        CHECK(kind IN ('cash','card','bank','savings','other')),
      currency CHAR(3) NOT NULL DEFAULT 'UAH',
      opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS wallets_user_idx
      ON wallets(user_id);

    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS wallet_id BIGINT;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'transactions_wallet_fk'
      ) THEN
        ALTER TABLE transactions
          ADD CONSTRAINT transactions_wallet_fk
          FOREIGN KEY (wallet_id)
          REFERENCES wallets(id)
          ON DELETE SET NULL;
      END IF;
    END $$;

    -- Create a default wallet for every existing user.

    INSERT INTO wallets(user_id, name, kind, is_default)
    SELECT u.id, 'Основной кошелёк', 'cash', true
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM wallets w WHERE w.user_id = u.id
    );

    -- Attach old transactions to the default wallet.

    UPDATE transactions t
    SET wallet_id = (
      SELECT w.id
      FROM wallets w
      WHERE w.user_id = t.user_id
      ORDER BY w.is_default DESC, w.id ASC
      LIMIT 1
    )
    WHERE t.wallet_id IS NULL;

    CREATE INDEX IF NOT EXISTS transactions_wallet_date_idx
      ON transactions(user_id, wallet_id, occurred_on DESC);

    -- TRANSFERS BETWEEN OWN WALLETS

    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_wallet_id BIGINT NOT NULL REFERENCES wallets(id),
      to_wallet_id BIGINT NOT NULL REFERENCES wallets(id),
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      note TEXT NOT NULL DEFAULT '',
      transferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(from_wallet_id <> to_wallet_id)
    );

    CREATE INDEX IF NOT EXISTS transfers_user_date_idx
      ON wallet_transfers(user_id, transferred_at DESC);

    -- MULTIPLE WORKPLACES

    CREATE TABLE IF NOT EXISTS workplaces (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      pay_type TEXT NOT NULL DEFAULT 'per_shift'
        CHECK(pay_type IN ('per_shift','hourly','fixed')),
      rate NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency CHAR(3) NOT NULL DEFAULT 'UAH',
      color TEXT NOT NULL DEFAULT '#54d9ff',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS workplaces_user_idx
      ON workplaces(user_id);

    -- Separate table: old shifts remain untouched.
    -- This allows multiple workplaces and shifts on the same date.

    CREATE TABLE IF NOT EXISTS work_shifts (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workplace_id BIGINT NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
      shift_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'worked'
        CHECK(status IN ('worked','day_off','planned')),
      hours NUMERIC(7,2) NOT NULL DEFAULT 0 CHECK(hours >= 0),
      amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(amount >= 0),
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS work_shifts_user_date_idx
      ON work_shifts(user_id, shift_date DESC);

    -- RECURRING PAYMENTS AND SUBSCRIPTIONS

    CREATE TABLE IF NOT EXISTS recurring_payments (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      category TEXT NOT NULL DEFAULT 'Подписки',
      cadence TEXT NOT NULL DEFAULT 'monthly'
        CHECK(cadence IN ('weekly','monthly','yearly')),
      next_due DATE NOT NULL,
      wallet_id BIGINT REFERENCES wallets(id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS recurring_user_due_idx
      ON recurring_payments(user_id, next_due);

    -- GOAL CONTRIBUTIONS

    CREATE TABLE IF NOT EXISTS goal_contributions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      contributed_on DATE NOT NULL DEFAULT CURRENT_DATE,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS goal_contributions_goal_idx
      ON goal_contributions(user_id, goal_id, contributed_on DESC);

    -- AUTOMATIC SAVING RULES

    CREATE TABLE IF NOT EXISTS goal_saving_rules (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      cadence TEXT NOT NULL
        CHECK(cadence IN ('daily','weekly','monthly')),
      next_run DATE NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- CATEGORY BUDGETS

    CREATE TABLE IF NOT EXISTS budgets (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      monthly_limit NUMERIC(14,2) NOT NULL CHECK(monthly_limit > 0),
      month_start DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, category, month_start)
    );

    -- NET WORTH HISTORY

    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      assets NUMERIC(14,2) NOT NULL DEFAULT 0,
      liabilities NUMERIC(14,2) NOT NULL DEFAULT 0,
      net_worth NUMERIC(14,2) NOT NULL DEFAULT 0,
      UNIQUE(user_id, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS net_worth_user_date_idx
      ON net_worth_snapshots(user_id, snapshot_date);

    -- DEBTS

    CREATE TABLE IF NOT EXISTS debts (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      person TEXT NOT NULL,
      direction TEXT NOT NULL
        CHECK(direction IN ('i_owe','owed_to_me')),
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      remaining NUMERIC(14,2) NOT NULL CHECK(remaining >= 0),
      due_date DATE,
      note TEXT NOT NULL DEFAULT '',
      is_settled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS debts_user_idx
      ON debts(user_id, is_settled);

    -- NOTIFICATIONS

    CREATE TABLE IF NOT EXISTS nexus_notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'info',
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS nexus_notifications_user_idx
      ON nexus_notifications(user_id, created_at DESC);

    -- PRIVATE DOCUMENT STORAGE
    -- Files are stored in PostgreSQL, not in the temporary Render filesystem.
    -- API must enforce the 8 MB limit and authenticate every request.

    CREATE TABLE IF NOT EXISTS private_documents (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Другое',
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL
        CHECK(mime_type IN (
          'image/jpeg',
          'image/png',
          'image/webp',
          'application/pdf'
        )),
      byte_size INTEGER NOT NULL
        CHECK(byte_size BETWEEN 1 AND 8388608),
      file_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS private_documents_user_idx
      ON private_documents(user_id, created_at DESC);

    -- ACHIEVEMENTS

    CREATE TABLE IF NOT EXISTS user_achievements (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      achievement_key TEXT NOT NULL,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE(user_id, achievement_key)
    );
  `);

  console.log("NEXUS: database ready.");
}
