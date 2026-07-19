import { PrismaClient } from '@prisma/client';
import { getLogger } from '../utils/logger.js';

const log = getLogger('Prisma');

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });
    prisma.$on('error' as never, (e: unknown) => log.error({ e }, 'Prisma error'));
  }
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
