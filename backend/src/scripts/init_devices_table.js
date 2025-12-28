import { poolPromise, sql } from "../db.js";

async function run() {
  try {
    console.log("Connecting to DB...");
    const pool = await poolPromise;
    console.log("Connected. Checking UserDevices table...");

    await pool.query(`
      IF OBJECT_ID('dbo.UserDevices', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.UserDevices (
          Id INT IDENTITY(1,1) PRIMARY KEY,
          UserId INT NOT NULL,
          DeviceId VARCHAR(64) NOT NULL,
          PublicKeyPem NVARCHAR(MAX) NOT NULL,
          CreatedAt DATETIME2 DEFAULT SYSDATETIME(),
          LastSeenAt DATETIME2,
          CONSTRAINT FK_UserDevices_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(Id),
          CONSTRAINT UQ_User_Device UNIQUE (UserId, DeviceId)
        );
        PRINT 'Table UserDevices created.';
      END
      ELSE
      BEGIN
        PRINT 'Table UserDevices already exists.';
      END
    `);

    console.log("Done.");
    process.exit(0);
  } catch (e) {
    console.error("Error init DB:", e);
    process.exit(1);
  }
}

run();
