import { PrismaClient } from "@prisma/client";

export class RuleStore {
  constructor({ databaseUrl }) {
    if (!process.env.DATABASE_URL && databaseUrl) {
      process.env.DATABASE_URL = databaseUrl;
    }
    this.prisma = new PrismaClient();
  }

  async list() {
    return this.prisma.rule.findMany({ orderBy: { createdAt: "desc" } });
  }

  async create(rule) {
    return this.prisma.rule.create({
      data: {
        id: rule.id,
        name: rule.name || rule.id,
        when: rule.when,
        then: rule.then,
        enabled: rule.enabled ?? true
      }
    });
  }

  async delete(id) {
    await this.prisma.rule.delete({ where: { id } });
  }

  async close() {
    await this.prisma.$disconnect();
  }
}
