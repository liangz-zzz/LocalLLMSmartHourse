# AGENTS – Prisma

用途：统一的 Postgres Schema（Prisma），供设备适配器与网关共享。

Schema 位置
- `backend/prisma/schema.prisma` 定义 `Device` / `DeviceState`（JSONB 存放 placement/bindings/capabilities/traits 等）。

命令（默认 DATABASE_URL=postgres://smarthome:smarthome@db:5432/smarthome）
- 生成客户端：`DATABASE_URL=... npx prisma generate --schema backend/prisma/schema.prisma`
- 推送 schema（开发环境）：`DATABASE_URL=... npx prisma db push --schema backend/prisma/schema.prisma`
- 迁移（如需）：`DATABASE_URL=... npx prisma migrate dev --schema backend/prisma/schema.prisma -n init`

注意：`@prisma/client` 需在使用方包中安装并执行 `prisma generate` 后才能导入。
