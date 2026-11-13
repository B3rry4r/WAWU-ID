import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface MailAudiencePage {
  data: { id: string; email: string; firstName: string | null }[];
  nextCursor: string | null;
  /** Every account that matches, not only this page. */
  total: number;
}

/**
 * Accounts a bulk email may go to: status active (so not suspended, banned or
 * waiting to be deleted), not marked deleted (deletedAt), with an email that
 * has been proven by a code (emailVerified). Reads only. `id` is the WAWU ID
 * user id, the one the Hub stores as wawuUserId.
 */
@Injectable()
export class MailAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    cursor: string | undefined,
    limit: number,
  ): Promise<MailAudiencePage> {
    const base = {
      status: 'active' as const,
      emailVerified: true,
      deletedAt: null,
      AND: [{ email: { not: null } }, { email: { not: '' } }],
    };
    const [rows, total] = await Promise.all([
      this.prisma.wawuUser.findMany({
        where: cursor ? { ...base, id: { gt: cursor } } : base,
        orderBy: { id: 'asc' },
        take: limit + 1,
        select: { id: true, email: true, firstName: true },
      }),
      this.prisma.wawuUser.count({ where: base }),
    ]);
    const more = rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    return {
      data: pageRows.map((r) => ({
        id: r.id,
        email: r.email as string,
        firstName: r.firstName?.trim() ? r.firstName.trim() : null,
      })),
      nextCursor: more ? pageRows[pageRows.length - 1].id : null,
      total,
    };
  }
}
