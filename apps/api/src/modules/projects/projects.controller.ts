import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../../prisma.service.js';
import { TenancyService, Principal, RequireRole } from '../../common/guards.js';
import type { AuthPrincipal } from '../auth/auth.service.js';
import { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../common/errors.js';

class CreateProjectDto {
  @ApiProperty() @IsString() org_id!: string;
  @ApiProperty() @IsString() @MaxLength(100) name!: string;
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, { message: 'slug must be lowercase alphanumeric with hyphens' })
  slug!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

class UpdateProjectDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

class CreateRetryPolicyDto {
  @ApiProperty() @IsString() @MaxLength(64) name!: string;
  @ApiProperty({ enum: ['FIXED', 'LINEAR', 'EXPONENTIAL'] })
  @IsIn(['FIXED', 'LINEAR', 'EXPONENTIAL'])
  strategy!: 'FIXED' | 'LINEAR' | 'EXPONENTIAL';
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) @Max(50) max_attempts!: number;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(0) base_delay_ms!: number;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(0) max_delay_ms!: number;
  @ApiPropertyOptional({ default: 10 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100)
  jitter_pct?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() retry_on_error_codes?: string[];
}

class CreateApiKeyDto {
  @ApiProperty() @IsString() @MaxLength(64) name!: string;
  @ApiPropertyOptional({ type: [String], default: ['jobs:read', 'jobs:write'] })
  @IsOptional() @IsArray()
  scopes?: string[];
}

@ApiTags('projects')
@Controller()
export class ProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly auth: AuthService,
  ) {}

  @Get('orgs')
  @ApiOperation({ summary: 'Organizations the caller belongs to' })
  async orgs(@Principal() principal: AuthPrincipal) {
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: principal.orgIds ?? [] } },
      include: { _count: { select: { projects: true } } },
    });
    return {
      data: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        project_count: o._count.projects,
      })),
    };
  }

  @Get('projects')
  async list(@Principal() principal: AuthPrincipal) {
    const projects = await this.prisma.project.findMany({
      // Scoped to the caller's memberships, never to a supplied org id.
      where: { orgId: { in: principal.orgIds ?? [] }, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { queues: true } } },
    });
    return { data: projects.map(toProject) };
  }

  @Post('projects')
  @HttpCode(201)
  @RequireRole('OWNER', 'ADMIN')
  async create(@Body() dto: CreateProjectDto, @Principal() principal: AuthPrincipal) {
    await this.tenancy.org(principal, dto.org_id);
    await this.tenancy.requireRole(principal, dto.org_id, ['OWNER', 'ADMIN']);

    const project = await this.prisma.project.create({
      data: {
        orgId: dto.org_id,
        name: dto.name,
        slug: dto.slug,
        description: dto.description ?? null,
        ...(principal.kind === 'user' ? { createdById: principal.userId } : {}),
      },
      include: { _count: { select: { queues: true } } },
    });
    return toProject(project);
  }

  @Get('projects/:projectId')
  async detail(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { _count: { select: { queues: true, jobs: true, scheduledJobs: true } } },
    });
    return toProject(project);
  }

  @Patch('projects/:projectId')
  async update(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
      },
      include: { _count: { select: { queues: true } } },
    });
    return toProject(project);
  }

  @Delete('projects/:projectId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Archive a project',
    description:
      'A soft delete. Hard-deleting would cascade to every job, execution and log — which is exactly the audit trail you want after deciding a project was a mistake.',
  })
  async archive(
    @Param('projectId') projectId: string,
    @Principal() principal: AuthPrincipal,
  ): Promise<void> {
    const project = await this.tenancy.project(principal, projectId);
    await this.tenancy.requireRole(principal, project.orgId, ['OWNER', 'ADMIN']);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { archivedAt: new Date() },
    });
  }

  // ── Retry policies ────────────────────────────────────────────────────────

  @Get('projects/:projectId/retry-policies')
  async policies(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);
    const rows = await this.prisma.retryPolicy.findMany({
      where: { projectId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { queues: true } } },
    });
    return { data: rows.map(toPolicy) };
  }

  @Post('projects/:projectId/retry-policies')
  @HttpCode(201)
  async createPolicy(
    @Param('projectId') projectId: string,
    @Body() dto: CreateRetryPolicyDto,
    @Principal() principal: AuthPrincipal,
  ) {
    await this.tenancy.project(principal, projectId);
    if (dto.max_delay_ms < dto.base_delay_ms) {
      throw AppError.badRequest('max_delay_ms must be greater than or equal to base_delay_ms');
    }
    const policy = await this.prisma.retryPolicy.create({
      data: {
        projectId,
        name: dto.name,
        strategy: dto.strategy,
        maxAttempts: dto.max_attempts,
        baseDelayMs: dto.base_delay_ms,
        maxDelayMs: dto.max_delay_ms,
        jitterPct: dto.jitter_pct ?? 10,
        retryOnErrorCodes: dto.retry_on_error_codes ?? [],
      },
      include: { _count: { select: { queues: true } } },
    });
    return toPolicy(policy);
  }

  @Delete('retry-policies/:policyId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a retry policy',
    description:
      'Returns 409 if any queue still references it — the FK is ON DELETE RESTRICT, so this fails loudly rather than leaving queues undefined.',
  })
  async deletePolicy(
    @Param('policyId') policyId: string,
    @Principal() principal: AuthPrincipal,
  ): Promise<void> {
    const policy = await this.prisma.retryPolicy.findUniqueOrThrow({ where: { id: policyId } });
    await this.tenancy.project(principal, policy.projectId);
    // The P2014/P2003 mapping in AppExceptionFilter turns the FK violation into
    // a clean 409 IN_USE rather than a 500.
    await this.prisma.retryPolicy.delete({ where: { id: policyId } });
  }

  // ── API keys ──────────────────────────────────────────────────────────────

  @Get('projects/:projectId/api-keys')
  async apiKeys(@Param('projectId') projectId: string, @Principal() principal: AuthPrincipal) {
    await this.tenancy.project(principal, projectId);
    const keys = await this.prisma.apiKey.findMany({
      where: { projectId, revokedAt: null },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });
    // Note there is no way to retrieve the plaintext. If we could show it
    // again, so could anyone who compromised the database.
    return { data: keys };
  }

  @Post('projects/:projectId/api-keys')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Issue an API key',
    description: 'The plaintext key is returned ONCE and never again. Only its SHA-256 is stored.',
  })
  async createApiKey(
    @Param('projectId') projectId: string,
    @Body() dto: CreateApiKeyDto,
    @Principal() principal: AuthPrincipal,
  ) {
    const project = await this.tenancy.project(principal, projectId);
    await this.tenancy.requireRole(principal, project.orgId, ['OWNER', 'ADMIN']);
    if (principal.kind !== 'user') {
      throw AppError.forbidden('API keys cannot be used to mint further API keys');
    }
    return this.auth.createApiKey(
      projectId,
      dto.name,
      principal.userId,
      dto.scopes ?? ['jobs:read', 'jobs:write'],
    );
  }

  @Delete('api-keys/:keyId')
  @HttpCode(204)
  async revokeApiKey(
    @Param('keyId') keyId: string,
    @Principal() principal: AuthPrincipal,
  ): Promise<void> {
    const key = await this.prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    await this.tenancy.project(principal, key.projectId);
    // Revoked, not deleted: the audit trail of what this key did stays intact.
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  }
}

function toProject(p: Record<string, unknown>) {
  const counts = (p['_count'] ?? {}) as Record<string, number>;
  return {
    id: p['id'],
    org_id: p['orgId'],
    name: p['name'],
    slug: p['slug'],
    description: p['description'],
    queue_count: counts['queues'] ?? 0,
    job_count: counts['jobs'],
    schedule_count: counts['scheduledJobs'],
    created_at: p['createdAt'],
  };
}

function toPolicy(p: Record<string, unknown>) {
  const counts = (p['_count'] ?? {}) as Record<string, number>;
  return {
    id: p['id'],
    name: p['name'],
    strategy: p['strategy'],
    max_attempts: p['maxAttempts'],
    base_delay_ms: p['baseDelayMs'],
    max_delay_ms: p['maxDelayMs'],
    jitter_pct: p['jitterPct'],
    retry_on_error_codes: p['retryOnErrorCodes'],
    is_default: p['isDefault'],
    queue_count: counts['queues'] ?? 0,
  };
}
