import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpStatus,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service.js';
import { AuthService, type AuthPrincipal } from '../modules/auth/auth.service.js';
import { AppError, ERROR_CODES } from './errors.js';

export const IS_PUBLIC = 'isPublic';
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_ROLES = 'requiredRoles';
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export const RequireRole = (...roles: Role[]): MethodDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

export interface AuthedRequest extends Request {
  principal?: AuthPrincipal;
  requestId?: string;
}

export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().principal;
});

/**
 * Accepts either a bearer JWT (dashboard traffic) or an `X-API-Key`
 * (programmatic traffic). Both resolve to the same `AuthPrincipal`, so nothing
 * downstream has to care which was used.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const apiKey = req.header('x-api-key');
    if (apiKey) {
      req.principal = await this.auth.validateApiKey(apiKey);
      return true;
    }

    const authHeader = req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication required. Send a Bearer token or an X-API-Key header.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        email: string;
        orgs: string[];
      }>(authHeader.slice(7), {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      req.principal = {
        userId: payload.sub,
        email: payload.email,
        orgIds: payload.orgs ?? [],
        kind: 'user',
      };
      return true;
    } catch {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Access token is invalid or expired',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}

/**
 * Resolves the tenant that owns whatever the route addresses, and proves the
 * caller belongs to it.
 *
 * ⚠️ THE RULE: tenancy is never inferred from a path parameter alone. Every
 * lookup walks the ownership chain back to an organization and checks it
 * against the principal's memberships. A route like
 * `GET /jobs/:id` must not return a job just because the id is well-formed.
 *
 * Failures are 404, not 403 — see AppError.notFound.
 */
@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  private assertMember(principal: AuthPrincipal | undefined, orgId: string): void {
    if (!principal) throw AppError.forbidden();
    if (!principal.orgIds?.includes(orgId)) throw AppError.notFound('Resource');
  }

  async project(principal: AuthPrincipal | undefined, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, orgId: true, archivedAt: true },
    });
    if (!project) throw AppError.notFound('Project');
    this.assertMember(principal, project.orgId);

    // An API key is bound to exactly one project. Holding a valid key for
    // project A must not grant access to project B in the same org.
    if (principal?.kind === 'api_key' && principal.projectId !== projectId) {
      throw AppError.notFound('Project');
    }
    return project;
  }

  async queue(principal: AuthPrincipal | undefined, queueId: string) {
    const queue = await this.prisma.queue.findUnique({
      where: { id: queueId },
      select: {
        id: true,
        name: true,
        projectId: true,
        isPaused: true,
        dlqEnabled: true,
        defaultPriority: true,
        defaultJobTimeoutMs: true,
        retryPolicyId: true,
        project: { select: { orgId: true } },
      },
    });
    if (!queue) throw AppError.notFound('Queue');
    this.assertMember(principal, queue.project.orgId);
    if (principal?.kind === 'api_key' && principal.projectId !== queue.projectId) {
      throw AppError.notFound('Queue');
    }
    return queue;
  }

  async job(principal: AuthPrincipal | undefined, jobId: string) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { project: { select: { orgId: true } } },
    });
    if (!job) throw AppError.notFound('Job');
    this.assertMember(principal, job.project.orgId);
    if (principal?.kind === 'api_key' && principal.projectId !== job.projectId) {
      throw AppError.notFound('Job');
    }
    return job;
  }

  async org(principal: AuthPrincipal | undefined, orgId: string) {
    this.assertMember(principal, orgId);
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw AppError.notFound('Organization');
    return org;
  }

  /** RBAC. Only consulted on routes carrying @RequireRole. */
  async requireRole(
    principal: AuthPrincipal | undefined,
    orgId: string,
    allowed: Role[],
  ): Promise<void> {
    if (!principal) throw AppError.forbidden();
    // API keys carry scopes, not org roles — they are already project-scoped.
    if (principal.kind === 'api_key') return;

    const membership = await this.prisma.membership.findUnique({
      where: { orgId_userId: { orgId, userId: principal.userId } },
      select: { role: true },
    });
    if (!membership || !allowed.includes(membership.role as Role)) {
      throw AppError.forbidden(
        `This action requires one of: ${allowed.join(', ')}`,
      );
    }
  }
}
