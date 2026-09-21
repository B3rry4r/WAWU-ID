import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PublicPolicy {
  slug: string;
  version: string;
  title: string;
  url: string;
  effectiveDate: string;
}

export interface PublishPolicyInput {
  slug: string;
  version: string;
  title: string;
  url: string;
  effectiveDate: string;
  summary?: string;
}

@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  private toPublic(p: {
    slug: string;
    version: string;
    title: string;
    url: string;
    effectiveDate: Date;
  }): PublicPolicy {
    return {
      slug: p.slug,
      version: p.version,
      title: p.title,
      url: p.url,
      effectiveDate: p.effectiveDate.toISOString(),
    };
  }

  /** The current published policy for a slug (latest effective date). */
  async getCurrent(slug: string): Promise<PublicPolicy> {
    const policy = await this.prisma.policy.findFirst({
      where: { slug, published: true },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
    if (!policy) {
      throw new NotFoundException(`No published policy for '${slug}'`);
    }
    return this.toPublic(policy);
  }

  /** The current published version of every policy, one per slug. */
  async listCurrent(): Promise<PublicPolicy[]> {
    const all = await this.prisma.policy.findMany({
      where: { published: true },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
    const seen = new Set<string>();
    const out: PublicPolicy[] = [];
    for (const p of all) {
      if (!seen.has(p.slug)) {
        seen.add(p.slug);
        out.push(this.toPublic(p));
      }
    }
    return out;
  }

  /** Publish (or re-publish) a policy version. Service-key guarded at the edge. */
  async publish(input: PublishPolicyInput): Promise<PublicPolicy> {
    const policy = await this.prisma.policy.upsert({
      where: { slug_version: { slug: input.slug, version: input.version } },
      update: {
        title: input.title,
        url: input.url,
        effectiveDate: new Date(input.effectiveDate),
        summary: input.summary ?? null,
        published: true,
      },
      create: {
        slug: input.slug,
        version: input.version,
        title: input.title,
        url: input.url,
        effectiveDate: new Date(input.effectiveDate),
        summary: input.summary ?? null,
        published: true,
      },
    });
    return this.toPublic(policy);
  }

  /**
   * Record a user's acceptance of the CURRENT version of a policy. Idempotent
   * per (user, slug, version): re-accepting the same version is a no-op.
   */
  async recordConsent(
    userId: string,
    slug: string,
    source?: string,
    ip?: string,
  ): Promise<{ recorded: boolean; slug: string; version: string }> {
    const current = await this.prisma.policy.findFirst({
      where: { slug, published: true },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
    if (!current) {
      throw new NotFoundException(`No published policy for '${slug}'`);
    }

    const existing = await this.prisma.consent.findFirst({
      where: { userId, slug, version: current.version },
    });
    if (existing) {
      return { recorded: false, slug, version: current.version };
    }

    await this.prisma.consent.create({
      data: { userId, slug, version: current.version, source: source ?? null, ip: ip ?? null },
    });
    return { recorded: true, slug, version: current.version };
  }

  /** Whether a user's most recent acceptance matches the current version. */
  async consentStatus(
    userId: string,
    slug: string,
  ): Promise<{
    slug: string;
    currentVersion: string;
    acceptedVersion: string | null;
    upToDate: boolean;
    needsConsent: boolean;
  }> {
    const current = await this.getCurrent(slug);
    const latest = await this.prisma.consent.findFirst({
      where: { userId, slug },
      orderBy: { acceptedAt: 'desc' },
    });
    const acceptedVersion = latest?.version ?? null;
    const upToDate = acceptedVersion === current.version;
    return {
      slug,
      currentVersion: current.version,
      acceptedVersion,
      upToDate,
      needsConsent: !upToDate,
    };
  }
}
