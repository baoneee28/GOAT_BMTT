import express from "express";
import { poolPromise, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";

export const msgRouter = express.Router();
msgRouter.use(authRequired);

/**
 * GET /api/messages/:conversationId?limit=50
 */
msgRouter.get("/:conversationId", async (req, res) => {
  const me = req.user.id;
  const conversationId = Number(req.params.conversationId);
  const limit = Math.min(Number(req.query.limit ?? 50), 200);

  const pool = await poolPromise;

  // check membership
  const mem = await pool.request()
    .input("ConversationId", sql.Int, conversationId)
    .input("UserId", sql.Int, me)
    .query(`SELECT 1 FROM dbo.ConversationMembers WHERE ConversationId=@ConversationId AND UserId=@UserId`);
  if (mem.recordset.length === 0) return res.status(403).json({ error: "Not a member" });

  const r = await pool.request()
    .input("ConversationId", sql.Int, conversationId)
    .input("Limit", sql.Int, limit)
    .query(`
      SELECT TOP (@Limit)
        Id, SenderId, Body, CreatedAt,
        CONVERT(VARCHAR(64), BodyHash, 2) AS BodyHashHex,
        CONVERT(VARCHAR(MAX), Signature, 2) AS SignatureHex
      FROM dbo.Messages
      WHERE ConversationId=@ConversationId
      ORDER BY Id DESC
    `);

  res.json({ messages: r.recordset.reverse() });
});
