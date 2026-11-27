import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
export type AuthRequest = Request & { userId?: number };
export function auth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in required" });
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET!) as { userId: number };
    req.userId = data.userId; next();
  } catch { return res.status(401).json({ error: "Session expired. Sign in again." }); }
}
