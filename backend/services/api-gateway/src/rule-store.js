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

  async get(id) {
    return this.prisma.rule.findUnique({ where: { id } });
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

  async update(id, patch) {
    return this.prisma.rule.update({
      where: { id },
      data: {
        name: patch.name,
        when: patch.when,
        then: patch.then,
        enabled: patch.enabled
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
