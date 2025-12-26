-- SQL Migration Script for GOAT_BMTT
-- Platform: SQL Server (T-SQL)
-- Purpose: Add 'Nonce' column for Replay Protection

USE [SecureChat]; -- Tên DB chính xác của bạn
GO

-- 1. Thêm cột Nonce (16 bytes) vào bảng Messages
IF NOT EXISTS (
    SELECT * FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[Messages]') 
    AND name = 'Nonce'
)
BEGIN
    PRINT 'Adding Nonce column...';
    ALTER TABLE [dbo].[Messages]
    ADD [Nonce] VARBINARY(16) NULL;
END
ELSE
BEGIN
    PRINT 'Nonce column already exists.';
END
GO

-- 2. Tạo Unique Index cho Nonce để chặn Replay
-- Chỉ index các dòng có Nonce khác NULL
IF NOT EXISTS (
    SELECT * FROM sys.indexes 
    WHERE name='UQ_Messages_Nonce' AND object_id = OBJECT_ID('dbo.Messages')
)
BEGIN
    PRINT 'Creating Unique Index UQ_Messages_Nonce...';
    CREATE UNIQUE INDEX [UQ_Messages_Nonce] 
    ON [dbo].[Messages]([Nonce]) 
    WHERE [Nonce] IS NOT NULL;
END
ELSE
BEGIN
    PRINT 'Index UQ_Messages_Nonce already exists.';
END
GO

PRINT 'Migration completed successfully.';
