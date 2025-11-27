import { PrismaClient } from "@prisma/client";

export class ActionResultStore {
  constructor({ databaseUrl }) {
    if (!process.env.DATABASE_URL && databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
    }
    this.prisma = new PrismaClient();
  }

  async save(result) {
    const createdAt = result.ts ? new Date(result.ts) : undefined;
    await this.prisma.actionResult.upsert({
      where: { id: result.id },
      update: {
        action: result.action,
        status: result.status,
        transport: result.transport,
        reason: result.reason || null,
        params: result.params || {},
        createdAt
      },
      create: {
        id: result.id,
        action: result.action,
        status: result.status,
        transport: result.transport,
        reason: result.reason || null,
        params: result.params || {},
        createdAt,
        device: {
          connectOrCreate: {
            where: { id: result.deviceId },
            create: {
              id: result.deviceId,
              name: result.deviceId,
              placement: {},
              protocol: "virtual",
              bindings: {},
              capabilities: []
            }
          }
        }
      }
    });
  }

  async listByDevice(deviceId, limit = 20) {
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return this.prisma.actionResult.findMany({
      where: { deviceId },
      orderBy: { createdAt: "desc" },
      take
    });
  }

  async close() {
    await this.prisma.$disconnect();
  }
}
