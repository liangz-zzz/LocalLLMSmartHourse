import { PrismaClient } from "@prisma/client";

export function ensureDatabaseUrl(url) {
  if (!process.env.DATABASE_URL && url) {
    process.env.DATABASE_URL = url;
  }
}

let prisma;

export function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export async function upsertDeviceAndState(device) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    await tx.device.upsert({
      where: { id: device.id },
      update: {
        name: device.name,
        placement: device.placement,
        protocol: device.protocol,
        bindings: device.bindings,
        capabilities: device.capabilities,
        semantics: device.semantics ?? {}
      },
      create: {
        id: device.id,
        name: device.name,
        placement: device.placement,
        protocol: device.protocol,
        bindings: device.bindings,
        capabilities: device.capabilities,
        semantics: device.semantics ?? {}
      }
    });

    await tx.deviceState.create({
      data: {
        deviceId: device.id,
        traits: device.traits
      }
    });
  });
}
