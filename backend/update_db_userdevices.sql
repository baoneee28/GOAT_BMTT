-- Create UserDevices table for multi-device support
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[UserDevices]') AND type in (N'U'))
BEGIN
    CREATE TABLE [dbo].[UserDevices](
        [Id] [int] IDENTITY(1,1) NOT NULL,
        [UserId] [int] NOT NULL,
        [DeviceId] [varchar](64) NOT NULL,
        [PublicKeyPem] [nvarchar](max) NOT NULL,
        [CreatedAt] [datetime2](7) DEFAULT (sysutcdatetime()),
        [LastSeenAt] [datetime2](7) NULL,
        PRIMARY KEY CLUSTERED ([Id] ASC),
        CONSTRAINT [UQ_User_Device] UNIQUE ([UserId], [DeviceId]),
        CONSTRAINT [FK_UserDevices_Users] FOREIGN KEY([UserId]) REFERENCES [dbo].[Users] ([Id])
    );
    
    CREATE NONCLUSTERED INDEX [IX_UserDevices_UserId] ON [dbo].[UserDevices]([UserId]);
END
GO
