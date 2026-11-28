
import express, { Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { pool, initDb } from "./db.js";
import { auth, AuthRequest } from "./auth.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(cors());
app.use(express.json({ limit: "12mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type R = AuthRequest;

const fail = (res: Response, error: unknown) => {
  console.error(error);
  return res.status(500).json({ error: "Server error" });
};

const userId = (req: R) => Number(req.userId);

const validAmount = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const asyncRoute = (
  fn: (req: R, res: Response) => Promise<unknown>
) => {
  return (req: R, res: Response) => {
    Promise.resolve(fn(req, res)).catch(error => fail(res, error));
  };
};

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", app: "NEXUS", version: "3.0" });
});

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const name = String(req.body.name || "NEXUS user").trim();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Enter a valid email" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must contain at least 6 characters" });
  }

  const exists = await pool.query(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );

  if (exists.rowCount) {
    return res.status(409).json({ error: "Account already exists" });
  }

  const hash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO users(email,password_hash,display_name)
     VALUES($1,$2,$3)
     RETURNING id,email,display_name`,
    [email, hash, name || "NEXUS user"]
  );

  const user = result.rows[0];

  await pool.query(
    `INSERT INTO wallets(user_id,name,kind,is_default)
     VALUES($1,'Основной кошелёк','cash',true)`,
    [user.id]
  );

  const token = jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.display_name
    }
  });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  const result = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.display_name
    }
  });
}));

app.get("/api/me", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id,email,display_name AS name,created_at
     FROM users WHERE id=$1`,
    [userId(req)]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: "User not found" });
  }

  return res.json({ user: result.rows[0] });
}));

// --------------------------------------------------
// SUMMARY / FINANCIAL CENTER
// --------------------------------------------------

app.get("/api/summary", auth, asyncRoute(async (req, res) => {
  const id = userId(req);

  const monthly = await pool.query(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type='income'),0) AS income,
      COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS expense
    FROM transactions
    WHERE user_id=$1
      AND occurred_on >= date_trunc('month', CURRENT_DATE)::date
      AND occurred_on < (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
  `, [id]);

  const wallets = await pool.query(`
    SELECT
      COALESCE(SUM(w.opening_balance),0)
      + COALESCE(SUM(COALESCE(t.income,0)-COALESCE(t.expense,0)),0)
      + COALESCE(SUM(COALESCE(tr.incoming,0)-COALESCE(tr.outgoing,0)),0)
      AS capital
    FROM wallets w
    LEFT JOIN (
      SELECT wallet_id,
        SUM(amount) FILTER(WHERE type='income') AS income,
        SUM(amount) FILTER(WHERE type='expense') AS expense
      FROM transactions
      WHERE user_id=$1
      GROUP BY wallet_id
    ) t ON t.wallet_id=w.id
    LEFT JOIN (
      SELECT wallet_id,
        SUM(incoming) AS incoming,
        SUM(outgoing) AS outgoing
      FROM (
        SELECT to_wallet_id AS wallet_id, SUM(amount) AS incoming, 0 AS outgoing
        FROM wallet_transfers WHERE user_id=$1 GROUP BY to_wallet_id
        UNION ALL
        SELECT from_wallet_id AS wallet_id, 0 AS incoming, SUM(amount) AS outgoing
        FROM wallet_transfers WHERE user_id=$1 GROUP BY from_wallet_id
      ) x GROUP BY wallet_id
    ) tr ON tr.wallet_id=w.id
    WHERE w.user_id=$1
  `, [id]);

  const debt = await pool.query(`
    SELECT
      COALESCE(SUM(remaining) FILTER(WHERE direction='i_owe'),0) AS liabilities,
      COALESCE(SUM(remaining) FILTER(WHERE direction='owed_to_me'),0) AS receivables
    FROM debts
    WHERE user_id=$1 AND is_settled=false
  `, [id]);

  const income = Number(monthly.rows[0].income);
  const expense = Number(monthly.rows[0].expense);
  const capital = Number(wallets.rows[0].capital);
  const liabilities = Number(debt.rows[0].liabilities);
  const receivables = Number(debt.rows[0].receivables);

  return res.json({
    income,
    expense,
    balance: income - expense,
    capital,
    liabilities,
    receivables,
    netWorth: capital + receivables - liabilities
  });
}));

// --------------------------------------------------
// TRANSACTIONS — OLD API COMPATIBILITY
// --------------------------------------------------

app.get("/api/transactions", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM transactions
     WHERE user_id=$1
     ORDER BY occurred_on DESC, id DESC`,
    [userId(req)]
  );

  return res.json(result.rows);
}));

app.post("/api/transactions", auth, asyncRoute(async (req, res) => {
  const id = userId(req);
  const { type, category, note, occurred_on } = req.body;
  const amount = validAmount(req.body.amount);

  if (!["income", "expense"].includes(type) || !amount || !category) {
    return res.status(400).json({ error: "Invalid transaction data" });
  }

  let walletId = req.body.wallet_id ? Number(req.body.wallet_id) : null;

  if (walletId) {
    const wallet = await pool.query(
      "SELECT id FROM wallets WHERE id=$1 AND user_id=$2",
      [walletId, id]
    );

    if (!wallet.rowCount) {
      return res.status(404).json({ error: "Wallet not found" });
    }
  } else {
    const wallet = await pool.query(
      `SELECT id FROM wallets
       WHERE user_id=$1
       ORDER BY is_default DESC,id ASC LIMIT 1`,
      [id]
    );

    walletId = wallet.rows[0]?.id || null;
  }

  const result = await pool.query(
    `INSERT INTO transactions
      (user_id,type,amount,category,note,occurred_on,wallet_id)
     VALUES($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7)
     RETURNING *`,
    [id, type, amount, String(category), String(note || ""), occurred_on || null, walletId]
  );

  return res.json(result.rows[0]);
}));

app.delete("/api/transactions/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM transactions WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

  return res.json({ success: true });
}));

// --------------------------------------------------
// WALLETS
// --------------------------------------------------

app.get("/api/wallets", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      w.*,
      w.opening_balance
      + COALESCE(t.income,0)-COALESCE(t.expense,0)
      + COALESCE(tr.incoming,0)-COALESCE(tr.outgoing,0) AS balance
    FROM wallets w
    LEFT JOIN (
      SELECT wallet_id,
        SUM(amount) FILTER(WHERE type='income') AS income,
        SUM(amount) FILTER(WHERE type='expense') AS expense
      FROM transactions WHERE user_id=$1 GROUP BY wallet_id
    ) t ON t.wallet_id=w.id
    LEFT JOIN (
      SELECT wallet_id,SUM(incoming) AS incoming,SUM(outgoing) AS outgoing
      FROM (
        SELECT to_wallet_id AS wallet_id,SUM(amount) AS incoming,0 AS outgoing
        FROM wallet_transfers WHERE user_id=$1 GROUP BY to_wallet_id
        UNION ALL
        SELECT from_wallet_id AS wallet_id,0 AS incoming,SUM(amount) AS outgoing
        FROM wallet_transfers WHERE user_id=$1 GROUP BY from_wallet_id
      ) x GROUP BY wallet_id
    ) tr ON tr.wallet_id=w.id
    WHERE w.user_id=$1
    ORDER BY w.is_default DESC,w.id
  `, [userId(req)]);

  return res.json(result.rows);
}));

app.post("/api/wallets", auth, asyncRoute(async (req, res) => {
  const id = userId(req);
  const name = String(req.body.name || "").trim();
  const kind = String(req.body.kind || "cash");
  const opening = Number(req.body.opening_balance || 0);

  if (!name || !Number.isFinite(opening)) {
    return res.status(400).json({ error: "Invalid wallet data" });
  }

  if (!["cash", "card", "bank", "savings", "other"].includes(kind)) {
    return res.status(400).json({ error: "Invalid wallet type" });
  }

  const result = await pool.query(
    `INSERT INTO wallets(user_id,name,kind,currency,opening_balance)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [id, name, kind, req.body.currency || "UAH", opening]
  );

  return res.json(result.rows[0]);
}));

app.patch("/api/wallets/:id", auth, asyncRoute(async (req, res) => {
  const id = userId(req);
  const result = await pool.query(
    `UPDATE wallets SET
      name=COALESCE($1,name),
      kind=COALESCE($2,kind),
      opening_balance=COALESCE($3,opening_balance)
     WHERE id=$4 AND user_id=$5 RETURNING *`,
    [
      req.body.name ?? null,
      req.body.kind ?? null,
      req.body.opening_balance ?? null,
      req.params.id,
      id
    ]
  );

  if (!result.rowCount) return res.status(404).json({ error: "Wallet not found" });
  return res.json(result.rows[0]);
}));

app.delete("/api/wallets/:id", auth, asyncRoute(async (req, res) => {
  const id = userId(req);

  const count = await pool.query(
    "SELECT COUNT(*) FROM wallets WHERE user_id=$1",
    [id]
  );

  if (Number(count.rows[0].count) <= 1) {
    return res.status(400).json({ error: "You must keep at least one wallet" });
  }

  const result = await pool.query(
    "DELETE FROM wallets WHERE id=$1 AND user_id=$2",
    [req.params.id, id]
  );

  if (!result.rowCount) return res.status(404).json({ error: "Wallet not found" });
  return res.json({ success: true });
}));

// --------------------------------------------------
// TRANSFERS
// --------------------------------------------------

app.get("/api/transfers", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT t.*,a.name AS from_name,b.name AS to_name
    FROM wallet_transfers t
    JOIN wallets a ON a.id=t.from_wallet_id
    JOIN wallets b ON b.id=t.to_wallet_id
    WHERE t.user_id=$1
    ORDER BY transferred_at DESC
  `, [userId(req)]);

  return res.json(result.rows);
}));

app.post("/api/transfers", auth, asyncRoute(async (req, res) => {
  const id = userId(req);
  const amount = validAmount(req.body.amount);
  const from = Number(req.body.from_wallet_id);
  const to = Number(req.body.to_wallet_id);

  if (!amount || !from || !to || from === to) {
    return res.status(400).json({ error: "Invalid transfer data" });
  }

  const wallets = await pool.query(
    "SELECT id FROM wallets WHERE user_id=$1 AND id=ANY($2::bigint[])",
    [id, [from, to]]
  );

  if (wallets.rowCount !== 2) {
    return res.status(400).json({ error: "Both wallets must belong to your account" });
  }

  const result = await pool.query(
    `INSERT INTO wallet_transfers
      (user_id,from_wallet_id,to_wallet_id,amount,note)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [id, from, to, amount, String(req.body.note || "")]
  );

  return res.json(result.rows[0]);
}));

app.delete("/api/transfers/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM wallet_transfers WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

  return res.json({ success: true });
}));

// --------------------------------------------------
// LEGACY SHIFTS
// --------------------------------------------------

app.get("/api/shifts", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM shifts WHERE user_id=$1 ORDER BY shift_date",
    [userId(req)]
  );

  return res.json(result.rows);
}));

app.post("/api/shifts", auth, asyncRoute(async (req, res) => {
  const { shift_date, status, hours, pay_type, amount, note } = req.body;

  if (!shift_date) {
    return res.status(400).json({ error: "Shift date required" });
  }

  const result = await pool.query(
    `INSERT INTO shifts
      (user_id,shift_date,status,hours,pay_type,amount,note)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(user_id,shift_date)
     DO UPDATE SET status=EXCLUDED.status,
       hours=EXCLUDED.hours,
       pay_type=EXCLUDED.pay_type,
       amount=EXCLUDED.amount,
       note=EXCLUDED.note
     RETURNING *`,
    [
      userId(req),
      shift_date,
      status || "worked",
      Number(hours || 0),
      pay_type || "per_shift",
      Number(amount || 0),
      String(note || "")
    ]
  );

  return res.json(result.rows[0]);
}));

app.delete("/api/shifts/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM shifts WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

  return res.json({ success: true });
}));

// --------------------------------------------------
// WORKPLACES
// --------------------------------------------------

app.get("/api/workplaces", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM workplaces WHERE user_id=$1 ORDER BY id",
    [userId(req)]
  );

  return res.json(result.rows);
}));

app.post("/api/workplaces", auth, asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const rate = Number(req.body.rate || 0);
  const payType = req.body.pay_type || "per_shift";

  if (!name || !Number.isFinite(rate) || rate < 0) {
    return res.status(400).json({ error: "Invalid workplace data" });
  }

  if (!["per_shift", "hourly", "fixed"].includes(payType)) {
    return res.status(400).json({ error: "Invalid pay type" });
  }

  const result = await pool.query(
    `INSERT INTO workplaces(user_id,name,pay_type,rate,color)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [userId(req), name, payType, rate, req.body.color || "#54d9ff"]
  );

  return res.json(result.rows[0]);
}));

app.patch("/api/workplaces/:id", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE workplaces SET
      name=COALESCE($1,name),
      rate=COALESCE($2,rate),
      is_active=COALESCE($3,is_active),
      color=COALESCE($4,color)
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [
      req.body.name ?? null,
      req.body.rate ?? null,
      req.body.is_active ?? null,
      req.body.color ?? null,
      req.params.id,
      userId(req)
    ]
  );

  if (!result.rowCount) return res.status(404).json({ error: "Workplace not found" });
  return res.json(result.rows[0]);
}));

app.delete("/api/workplaces/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM workplaces WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

  return res.json({ success: true });
}));

// --------------------------------------------------
// WORK SHIFTS — MULTIPLE JOBS
// --------------------------------------------------

app.get("/api/work-shifts", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT s.*,w.name AS workplace_name,w.color AS workplace_color
    FROM work_shifts s
    JOIN workplaces w ON w.id=s.workplace_id
    WHERE s.user_id=$1
    ORDER BY s.shift_date DESC,s.id DESC
  `, [userId(req)]);

  return res.json(result.rows);
}));

app.post("/api/work-shifts", auth, asyncRoute(async (req, res) => {
  const id = userId(req);
  const workplace = Number(req.body.workplace_id);
  const date = req.body.shift_date;
  const hours = Number(req.body.hours || 0);
  const amount = Number(req.body.amount || 0);
  const status = req.body.status || "worked";

  if (!workplace || !date || !Number.isFinite(hours) || hours < 0 ||
      !Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "Invalid shift data" });
  }

  if (!["worked", "day_off", "planned"].includes(status)) {
    return res.status(400).json({ error: "Invalid shift status" });
  }

  const check = await pool.query(
    "SELECT id FROM workplaces WHERE id=$1 AND user_id=$2",
    [workplace, id]
  );

  if (!check.rowCount) return res.status(404).json({ error: "Workplace not found" });

  const result = await pool.query(
    `INSERT INTO work_shifts
      (user_id,workplace_id,shift_date,status,hours,amount,note)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, workplace, date, status, hours, amount, String(req.body.note || "")]
  );

  return res.json(result.rows[0]);
}));

app.delete("/api/work-shifts/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM work_shifts WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

  return res.json({ success: true });
}));

// --------------------------------------------------
// GOALS — OLD API
// --------------------------------------------------

app.get("/api/goals", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM goals WHERE user_id=$1 ORDER BY created_at DESC",
    [userId(req)]
  );

  return res.json(result.rows);
}));

app.post("/api/goals", auth, asyncRoute(async (req, res) => {
  const title = String(req.body.title || "").trim();
  const target = validAmount(req.body.target);

  if (!title || !target) {
    return res.status(400).json({ error: "Invalid goal data" });
  }

  const result = await pool.query(
    `INSERT INTO goals(user_id,title,target,current,due_date)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [
      userId(req),
      title,
      target,
      Number(req.body.current || 0),
      req.body.due_date || null
    ]
  );

  return res.json(result.rows[0]);
}));

app.patch("/api/goals/:id", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE goals SET
      title=COALESCE($1,title),
      target=COALESCE($2,target),
      current=COALESCE($3,current),
      due_date=COALESCE($4,due_date)
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [
      req.body.title ?? null,
      req.body.target ?? null,
      req.body.current ?? null,
      req.body.due_date ?? null,
      req.params.id,
      userId(req)
    ]
  );

  if (!result.rowCount) return res.status(404).json({ error: "Goal not found" });
  return res.json(result.rows[0]);
}));

app.delete("/api/goals/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM goals WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

    return res.json(result.rows[0]);
}));

app.delete("/api/transactions/:id", auth, asyncRoute(async (req, res) => {
  await pool.query(
    "DELETE FROM transactions WHERE id=$1 AND user_id=$2",
    [req.params.id, userId(req)]
  );

  return res.json({ success: true });
}));

// --------------------------------------------------
// WALLETS
// --------------------------------------------------

app.get("/api/wallets", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      w.*,
      w.opening_balance
      + COALESCE(t.income,0)-COALESCE(t.expense,0)
      + COALESCE(tr.incoming,0)-COALESCE(tr.outgoing,0) AS balance
    FROM wallets w
    LEFT JOIN (
      SELECT wallet_id,
        SUM(amount) FILTER(WHERE type='income') AS income,
        SUM(amount) FILTER(WHERE type='expense') AS expense
      FROM transactions WHERE user_id=$1 GROUP BY wallet_id
    ) t ON t.wallet_id=w.id
    LEFT JOIN (
      SELECT wallet_id,SUM(incoming) AS incoming,SUM(outgoing) AS outgoing
      FROM (
        SELECT to_wallet_id AS wallet_id,SUM(amount) AS incoming,0 AS outgoing
        FROM wallet_transfers WHERE user_id=$1 GROUP BY to_wallet_id
        UNION ALL
        SELECT from_wallet_id AS wallet_id,0 AS incoming,SUM(amount) AS outgoing
        FROM wallet_transfers WHERE user_id=$1 GROUP BY from_wallet_id
      ) x GROUP BY wallet_id
    ) tr ON tr.wallet_id=w.id
    WHERE w.user_id=$1
    ORDER BY w.is_default DESC,w.id
  `, [userId(req)]);

  return res.json(result.rows);
})); 
