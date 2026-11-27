import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { pool, initDb } from "./db.js";
import { auth, AuthRequest } from "./auth.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
const port = Number(process.env.PORT || 4000);
const tokenFor = (userId: number) => jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: "30d" });
const asyncRoute = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req,res,next)).catch(next);

app.get("/api/health", (_req,res) => res.json({ ok:true, app:"NEXUS" }));

app.post("/api/auth/register", asyncRoute(async (req,res) => {
  const body = z.object({ email:z.string().email().max(200), password:z.string().min(8).max(100), name:z.string().min(1).max(80) }).parse(req.body);
  const hash = await bcrypt.hash(body.password, 12);
  try {
    const result = await pool.query("INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name", [body.email.toLowerCase(),hash,body.name]);
    const user = result.rows[0]; res.status(201).json({ token:tokenFor(user.id), user });
  } catch(e:any) { if(e.code==="23505") return res.status(409).json({error:"Email is already registered"}); throw e; }
}));
app.post("/api/auth/login", asyncRoute(async (req,res) => {
  const body = z.object({ email:z.string().email(), password:z.string() }).parse(req.body);
  const r = await pool.query("SELECT * FROM users WHERE email=$1",[body.email.toLowerCase()]);
  if(!r.rowCount || !(await bcrypt.compare(body.password,r.rows[0].password_hash))) return res.status(401).json({error:"Incorrect email or password"});
  const u=r.rows[0]; res.json({token:tokenFor(u.id),user:{id:u.id,email:u.email,display_name:u.display_name}});
}));
app.get("/api/me",auth,asyncRoute(async(req:AuthRequest,res)=> {
  const r=await pool.query("SELECT id,email,display_name FROM users WHERE id=$1",[req.userId]); res.json(r.rows[0]);
}));

app.get("/api/transactions",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const r=await pool.query("SELECT * FROM transactions WHERE user_id=$1 ORDER BY occurred_on DESC,id DESC LIMIT 300",[req.userId]);res.json(r.rows);
}));
app.post("/api/transactions",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const b=z.object({type:z.enum(["income","expense"]),amount:z.number().positive().max(100000000),category:z.string().min(1).max(60),note:z.string().max(500).optional(),occurred_on:z.string().optional()}).parse(req.body);
 const r=await pool.query("INSERT INTO transactions(user_id,type,amount,category,note,occurred_on) VALUES($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE)) RETURNING *",[req.userId,b.type,b.amount,b.category,b.note||"",b.occurred_on||null]);res.status(201).json(r.rows[0]);
}));
app.delete("/api/transactions/:id",auth,asyncRoute(async(req:AuthRequest,res)=>{
 await pool.query("DELETE FROM transactions WHERE id=$1 AND user_id=$2",[req.params.id,req.userId]);res.json({ok:true});
}));

app.get("/api/shifts",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const r=await pool.query("SELECT * FROM shifts WHERE user_id=$1 AND shift_date >= CURRENT_DATE - INTERVAL '1 year' ORDER BY shift_date DESC",[req.userId]);res.json(r.rows);
}));
app.post("/api/shifts",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const b=z.object({shift_date:z.string(),status:z.enum(["worked","day_off","planned"]),hours:z.number().min(0).max(24).default(0),pay_type:z.enum(["per_shift","hourly","monthly","custom"]).default("per_shift"),amount:z.number().min(0).max(100000000).default(0),note:z.string().max(500).optional()}).parse(req.body);
 const r=await pool.query(`INSERT INTO shifts(user_id,shift_date,status,hours,pay_type,amount,note) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(user_id,shift_date) DO UPDATE SET status=EXCLUDED.status,hours=EXCLUDED.hours,pay_type=EXCLUDED.pay_type,amount=EXCLUDED.amount,note=EXCLUDED.note RETURNING *`,
 [req.userId,b.shift_date,b.status,b.hours,b.pay_type,b.amount,b.note||""]);res.json(r.rows[0]);
}));
app.delete("/api/shifts/:id",auth,asyncRoute(async(req:AuthRequest,res)=>{await pool.query("DELETE FROM shifts WHERE id=$1 AND user_id=$2",[req.params.id,req.userId]);res.json({ok:true});}));

app.get("/api/goals",auth,asyncRoute(async(req:AuthRequest,res)=>{const r=await pool.query("SELECT * FROM goals WHERE user_id=$1 ORDER BY id DESC",[req.userId]);res.json(r.rows);}));
app.post("/api/goals",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const b=z.object({title:z.string().min(1).max(100),target:z.number().positive(),current:z.number().min(0).default(0),due_date:z.string().optional()}).parse(req.body);
 const r=await pool.query("INSERT INTO goals(user_id,title,target,current,due_date) VALUES($1,$2,$3,$4,$5) RETURNING *",[req.userId,b.title,b.target,b.current,b.due_date||null]);res.status(201).json(r.rows[0]);
}));
app.patch("/api/goals/:id",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const b=z.object({current:z.number().min(0).optional(),title:z.string().min(1).max(100).optional()}).parse(req.body);
 const r=await pool.query("UPDATE goals SET current=COALESCE($1,current),title=COALESCE($2,title) WHERE id=$3 AND user_id=$4 RETURNING *",[b.current??null,b.title??null,req.params.id,req.userId]);res.json(r.rows[0]||{});
}));
app.delete("/api/goals/:id",auth,asyncRoute(async(req:AuthRequest,res)=>{await pool.query("DELETE FROM goals WHERE id=$1 AND user_id=$2",[req.params.id,req.userId]);res.json({ok:true});}));

app.get("/api/reminders",auth,asyncRoute(async(req:AuthRequest,res)=>{const r=await pool.query("SELECT * FROM reminders WHERE user_id=$1 ORDER BY remind_at NULLS LAST,id DESC",[req.userId]);res.json(r.rows);}));
app.post("/api/reminders",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const b=z.object({title:z.string().min(1).max(160),remind_at:z.string().optional()}).parse(req.body);
 const r=await pool.query("INSERT INTO reminders(user_id,title,remind_at) VALUES($1,$2,$3) RETURNING *",[req.userId,b.title,b.remind_at||null]);res.status(201).json(r.rows[0]);
}));
app.patch("/api/reminders/:id",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const b=z.object({done:z.boolean()}).parse(req.body);const r=await pool.query("UPDATE reminders SET done=$1 WHERE id=$2 AND user_id=$3 RETURNING *",[b.done,req.params.id,req.userId]);res.json(r.rows[0]||{});
}));
app.delete("/api/reminders/:id",auth,asyncRoute(async(req:AuthRequest,res)=>{await pool.query("DELETE FROM reminders WHERE id=$1 AND user_id=$2",[req.params.id,req.userId]);res.json({ok:true});}));

app.get("/api/summary",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const uid=req.userId;
 const [totals,shifts,goals]=await Promise.all([
  pool.query(`SELECT type,COALESCE(SUM(amount),0) total FROM transactions WHERE user_id=$1 AND date_trunc('month',occurred_on)=date_trunc('month',CURRENT_DATE) GROUP BY type`,[uid]),
  pool.query(`SELECT COUNT(*) FILTER(WHERE status='worked') worked,COALESCE(SUM(amount) FILTER(WHERE status='worked'),0) shift_pay,COALESCE(SUM(hours) FILTER(WHERE status='worked'),0) hours FROM shifts WHERE user_id=$1 AND date_trunc('month',shift_date)=date_trunc('month',CURRENT_DATE)`,[uid]),
  pool.query("SELECT COUNT(*) count FROM goals WHERE user_id=$1",[uid])
 ]);
 const income=Number(totals.rows.find(x=>x.type==="income")?.total||0),expense=Number(totals.rows.find(x=>x.type==="expense")?.total||0);
 res.json({income,expense,balance:income-expense,worked:Number(shifts.rows[0].worked),shift_pay:Number(shifts.rows[0].shift_pay),hours:Number(shifts.rows[0].hours),goals:Number(goals.rows[0].count)});
}));
app.get("/api/backup",auth,asyncRoute(async(req:AuthRequest,res)=>{
 const uid=req.userId;const [transactions,shifts,goals,reminders]=await Promise.all([
  pool.query("SELECT * FROM transactions WHERE user_id=$1",[uid]),pool.query("SELECT * FROM shifts WHERE user_id=$1",[uid]),
  pool.query("SELECT * FROM goals WHERE user_id=$1",[uid]),pool.query("SELECT * FROM reminders WHERE user_id=$1",[uid])
 ]);
 res.setHeader("Content-Disposition",'attachment; filename="nexus-backup.json"');
 res.json({app:"NEXUS",version:1,exported_at:new Date().toISOString(),transactions:transactions.rows,shifts:shifts.rows,goals:goals.rows,reminders:reminders.rows});
}));

const openai = process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
app.post("/api/ai/chat",auth,asyncRoute(async(req:AuthRequest,res)=>{
 if(!openai) return res.status(503).json({error:"AI is not configured yet. Add OPENAI_API_KEY in Render environment."});
 const message=z.string().min(1).max(3000).parse(req.body.message);
 const uid=req.userId!;
 const summary=await pool.query(`SELECT type,COALESCE(SUM(amount),0) total FROM transactions WHERE user_id=$1 AND occurred_on >= CURRENT_DATE-30 GROUP BY type`,[uid]);
 const [recent,shifts]=await Promise.all([pool.query("SELECT type,amount,category,note,occurred_on FROM transactions WHERE user_id=$1 ORDER BY occurred_on DESC LIMIT 20",[uid]),pool.query("SELECT shift_date,status,hours,amount,pay_type FROM shifts WHERE user_id=$1 ORDER BY shift_date DESC LIMIT 20",[uid])]);
 const tools:any[]=[
  {type:"function",function:{name:"add_transaction",description:"Add a transaction for the signed-in user after they explicitly ask.",parameters:{type:"object",properties:{type:{type:"string",enum:["income","expense"]},amount:{type:"number"},category:{type:"string"},note:{type:"string"},occurred_on:{type:"string",description:"YYYY-MM-DD"}},required:["type","amount","category"]}}},
  {type:"function",function:{name:"mark_shift",description:"Create or update a work shift after the user explicitly asks.",parameters:{type:"object",properties:{shift_date:{type:"string",description:"YYYY-MM-DD"},status:{type:"string",enum:["worked","day_off","planned"]},hours:{type:"number"},pay_type:{type:"string",enum:["per_shift","hourly","monthly","custom"]},amount:{type:"number"},note:{type:"string"}},required:["shift_date","status"]}}}
 ];
 const messages:any[]=[
  {role:"system",content:`You are NEXUS AI, a helpful Ukrainian/Russian-language personal finance assistant. Respond in the language the user uses. Currency UAH. You may read only the signed-in user's data below. Never claim an action happened unless a tool succeeded. Use tools only when user clearly asks to perform an action; if key details are missing, ask. Do not provide financial investment guarantees. 30-day totals: ${JSON.stringify(summary.rows)}. Recent transactions: ${JSON.stringify(recent.rows)}. Recent shifts: ${JSON.stringify(shifts.rows)}.`},
  {role:"user",content:message}
 ];
 let response=await openai.chat.completions.create({model:process.env.OPENAI_MODEL||"gpt-4o-mini",messages,tools,tool_choice:"auto"});
 let msg=response.choices[0].message;
 if(msg.tool_calls?.length){
   messages.push(msg as any);
   for(const call of msg.tool_calls){
    const args=JSON.parse(call.function.arguments||"{}");let result:any;
    if(call.function.name==="add_transaction"){
      const b=z.object({type:z.enum(["income","expense"]),amount:z.number().positive(),category:z.string().min(1).max(60),note:z.string().max(500).optional(),occurred_on:z.string().optional()}).parse(args);
      const r=await pool.query("INSERT INTO transactions(user_id,type,amount,category,note,occurred_on) VALUES($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE)) RETURNING id,type,amount,category,occurred_on",[uid,b.type,b.amount,b.category,b.note||"",b.occurred_on||null]);result={success:true,transaction:r.rows[0]};
    } else if(call.function.name==="mark_shift"){
      const b=z.object({shift_date:z.string(),status:z.enum(["worked","day_off","planned"]),hours:z.number().min(0).max(24).optional(),pay_type:z.enum(["per_shift","hourly","monthly","custom"]).optional(),amount:z.number().min(0).optional(),note:z.string().max(500).optional()}).parse(args);
      const r=await pool.query(`INSERT INTO shifts(user_id,shift_date,status,hours,pay_type,amount,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,shift_date) DO UPDATE SET status=EXCLUDED.status,hours=EXCLUDED.hours,pay_type=EXCLUDED.pay_type,amount=EXCLUDED.amount,note=EXCLUDED.note RETURNING *`,[uid,b.shift_date,b.status,b.hours||0,b.pay_type||"per_shift",b.amount||0,b.note||""]);result={success:true,shift:r.rows[0]};
    }
    messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(result)});
   }
   response=await openai.chat.completions.create({model:process.env.OPENAI_MODEL||"gpt-4o-mini",messages,tools});
   msg=response.choices[0].message;
 }
 res.json({reply:msg.content||"Готово."});
}));

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const webDist=path.resolve(__dirname,"../../client/dist");
app.use(express.static(webDist));
app.get("*",(req,res,next)=>{if(req.path.startsWith("/api/")) return next();res.sendFile(path.join(webDist,"index.html"));});
app.use((err:any,_req:any,res:any,_next:any)=>{console.error(err);res.status(err instanceof z.ZodError?400:500).json({error:err instanceof z.ZodError?"Invalid input": "Server error"});});
initDb().then(()=>app.listen(port,()=>console.log(`NEXUS server on ${port}`))).catch(e=>{console.error("Database initialization failed",e);process.exit(1);});
