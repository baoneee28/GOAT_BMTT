import express from "express";
import { poolPromise, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";

export const convRouter = express.Router();

convRouter.use(authRequired);

/**
 * POST /api/conversations
 * body: { title, memberIds: [2,3,...] }  // tự thêm mình vào
 */
convRouter.post("/", async (req, res) => {
  const { title, memberIds } = req.body || {};
  const me = req.user.id;

  const members = new Set([me, ...(Array.isArray(memberIds) ? memberIds : [])]);

  const pool = await poolPromise;
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin();
    const createRes = await new sql.Request(tx)
      .input("Title", sql.NVarChar(100), title ?? null)
      .query(`INSERT INTO dbo.Conversations(Title) OUTPUT INSERTED.Id VALUES (@Title)`);

    const convId = createRes.recordset[0].Id;

    for (const uid of members) {
      await new sql.Request(tx)
        .input("ConversationId", sql.Int, convId)
        .input("UserId", sql.Int, uid)
        .query(`INSERT INTO dbo.ConversationMembers(ConversationId, UserId) VALUES (@ConversationId, @UserId)`);
    }

    await tx.commit();
    return res.json({ ok: true, conversationId: convId });
  } catch (e) {
    await tx.rollback();
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/conversations
 * list conv của user
 */
convRouter.get("/", async (req, res) => {
  const me = req.user.id;
  const pool = await poolPromise;

  const r = await pool.request()
    .input("UserId", sql.Int, me)
    .query(`
      SELECT c.Id, c.Title, c.CreatedAt
      FROM dbo.Conversations c
      JOIN dbo.ConversationMembers m ON m.ConversationId = c.Id
      WHERE m.UserId = @UserId
      ORDER BY c.Id DESC
    `);

  res.json({ conversations: r.recordset });
});
