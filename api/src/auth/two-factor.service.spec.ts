import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { User } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TwoFactorService } from './two-factor.service.js';

/** An in-memory stand-in for the recovery code table. */
function fakePrisma() {
  const rows: { userId: string; codeHash: string; usedAt: Date | null }[] = [];
  const prisma = {
    rows,
    recoveryCode: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === where.userId) rows.splice(i, 1);
      },
      createMany: async ({ data }: { data: { userId: string; codeHash: string }[] }) => { rows.push(...data.map((d) => ({ ...d, usedAt: null }))); },
      updateMany: async ({ where }: { where: { userId: string; codeHash: { in: string[] }; usedAt: null } }) => {
        const hit = rows.filter((r) => r.userId === where.userId && where.codeHash.in.includes(r.codeHash) && r.usedAt === null);
        hit.forEach((r) => (r.usedAt = new Date()));
        return { count: hit.length };
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return prisma;
}

const service = (prisma: ReturnType<typeof fakePrisma>, keys: { ENCRYPTION_KEY: string; ENCRYPTION_KEY_PREVIOUS?: string }) =>
  new TwoFactorService(prisma as unknown as PrismaService, { get: (k: string) => (keys as Record<string, string | undefined>)[k] } as unknown as ConfigService<never, true>);

const user = { id: 'u1', totpEnabledAt: new Date(), totpSecret: null } as unknown as User;

describe('recovery codes', () => {
  it('keep working after ENCRYPTION_KEY is rotated', async () => {
    const prisma = fakePrisma();
    const before = service(prisma, { ENCRYPTION_KEY: 'k'.repeat(40) });
    const codes = await (before as unknown as { replaceRecoveryCodes(id: string): Promise<string[]> }).replaceRecoveryCodes('u1');

    const rotated = service(prisma, { ENCRYPTION_KEY: 'n'.repeat(40), ENCRYPTION_KEY_PREVIOUS: 'k'.repeat(40) });
    expect(await rotated.verify(user, codes[0])).toBe(true);
    expect(await rotated.verify(user, codes[0])).toBe(false); // still single-use

    const forgotten = service(prisma, { ENCRYPTION_KEY: 'n'.repeat(40) }); // old key dropped too early
    expect(await forgotten.verify(user, codes[1])).toBe(false);
  });
});
