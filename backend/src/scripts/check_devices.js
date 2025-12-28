import { poolPromise, sql } from "../db.js";

async function run() {
  try {
    const pool = await poolPromise;
    console.log("Connected. Querying UserDevices...");

    const r = await pool.query(`
      SELECT u.Username, ud.DeviceId, substring(ud.PublicKeyPem, 1, 30) + '...' as ShortKey, ud.LastSeenAt 
      FROM dbo.UserDevices ud
      JOIN dbo.Users u ON u.Id = ud.UserId
    `);

    console.table(r.recordset);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
