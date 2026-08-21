import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma.service.js';
import { AppError, ERROR_CODES } from '../../common/errors.js';
import { ConfigService } from '@nestjs/config';

export interface AuthPrincipal {
  userId: string;
  email: string;
  /** Present for JWT auth; absent for API-key auth. */
  orgIds?: string[];
  /** Present for API-key auth, which is scoped to exactly one project. */
  projectId?: string;
  scopes?: string[];
  kind: 'user' | 'api_key';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(input: { email: string; password: string; name: string; orgName: string }) {
    const email = input.email.trim().toLowerCase();

    // One transaction: a user without an org, or an org without an owner, is a
    // half-created account somebody has to clean up by hand.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) {
        throw AppError.conflict(ERROR_CODES.CONFLICT, 'An account with that email already exists');
      }

      const user = await tx.user.create({
        data: { email, name: input.name, passwordHash: await hashPassword(input.password) },
      });

      const org = await tx.organization.create({
        data: { name: input.orgName, slug: await uniqueSlug(tx, input.orgName) },
      });

      await tx.membership.create({ data: { orgId: org.id, userId: user.id, role: 'OWNER' } });

      return { user, org };
    });
  }

  async validateCredentials(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // Always run a verification, even when the user does not exist, so the
    // response time does not reveal which emails are registered. Without this
    // the endpoint is a user-enumeration oracle regardless of the identical
    // error message.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const ok = await verifyPassword(hash, password);

    if (!user || !ok || !user.isActive) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Invalid email or password',
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return user;
  }

  async issueTokens(userId: string, email: string) {
    const orgIds = await this.orgIdsFor(userId);

    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, orgs: orgIds, kind: 'user' },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        // jsonwebtoken types expiresIn as a template-literal union it cannot
        // infer from config. The value is validated at boot, not here.
        expiresIn: (this.config.get<string>('JWT_ACCESS_TTL') ?? '15m') as never,
      },
    );

    // The refresh token carries a random jti so it can be rotated and, later,
    // revoked. Kept short-lived and httpOnly — see ARCHITECTURE.md §29.6.
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: randomBytes(16).toString('hex'), kind: 'refresh' },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: (this.config.get<string>('JWT_REFRESH_TTL') ?? '7d') as never,
      },
    );

    return { accessToken, refreshToken, expiresIn: 900 };
  }

  async refresh(token: string) {
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Refresh token is invalid or expired',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.isActive) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Account is no longer active',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Rotation: every refresh mints a NEW refresh token. A stolen token is
    // therefore usable at most once before the legitimate client's next
    // refresh invalidates the thief's copy.
    return this.issueTokens(user.id, user.email);
  }

  async orgIdsFor(userId: string): Promise<string[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { orgId: true },
    });
    return memberships.map((m) => m.orgId);
  }

  /**
   * API keys are verified by HASH, never by lookup of the plaintext.
   *
   * The stored value is SHA-256 of the key. A database leak therefore does not
   * hand the attacker working credentials. (SHA-256 rather than argon2 here is
   * deliberate: an API key is 24 bytes of CSPRNG output, so it has no
   * brute-forceable structure the way a human password does, and this runs on
   * every request.)
   */
  async validateApiKey(plaintext: string): Promise<AuthPrincipal> {
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      select: {
        id: true,
        projectId: true,
        scopes: true,
        revokedAt: true,
        expiresAt: true,
        project: { select: { orgId: true } },
      },
    });

    const now = new Date();
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < now)) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'API key is invalid, revoked or expired',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Fire-and-forget: last_used_at is useful for auditing but must never add
    // latency to, or fail, the request it describes.
    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: now } })
      .catch((err) => this.logger.warn(`failed to record api key usage: ${String(err)}`));

    return {
      userId: `apikey:${key.id}`,
      email: '',
      kind: 'api_key',
      projectId: key.projectId,
      orgIds: [key.project.orgId],
      scopes: key.scopes,
    };
  }

  async createApiKey(projectId: string, name: string, createdById: string, scopes: string[]) {
    // Shown once, at creation, and never recoverable. If we could show it
    // again, so could anyone who compromised the database.
    const plaintext = `sk_live_${randomBytes(24).toString('hex')}`;

    const key = await this.prisma.apiKey.create({
      data: {
        projectId,
        name,
        keyPrefix: plaintext.slice(0, 12),
        keyHash: createHash('sha256').update(plaintext).digest('hex'),
        scopes,
        createdById,
      },
      select: { id: true, name: true, keyPrefix: true, scopes: true, createdAt: true },
    });

    return { ...key, key: plaintext };
  }
}

async function hashPassword(password: string): Promise<string> {
  // argon2id: memory-hard, so GPU cracking of a leaked hash is expensive.
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  // The seed script writes a `seed$<sha256>` marker rather than a real hash.
  // Seeded accounts can NEVER log in — demo credentials that actually work are
  // how a demo database ends up reachable in production.
  //
  // We still burn the same work an argon2 verify would, so the seeded account
  // is not identifiable by how fast this endpoint rejects it.
  if (hash.startsWith('seed$')) {
    const expected = Buffer.from(hash.slice(5), 'hex');
    const actual = createHash('sha256').update(password).digest();
    if (expected.length === actual.length) timingSafeEqual(expected, actual);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Pre-computed so the "no such user" path costs the same as a real verify. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$T2VkZ2VkZ2VkZ2VkZ2VkZ2VkZ2VkZ2VkZ2VkZ2U';

async function uniqueSlug(
  tx: { organization: { findUnique(a: unknown): Promise<unknown> } },
  name: string,
): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org';

  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    const clash = await tx.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}
