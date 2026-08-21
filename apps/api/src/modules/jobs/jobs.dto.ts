import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LIMITS } from '@djs/core';
import { PaginationQuery } from '../../common/pagination.js';

export class CreateJobDto {
  @ApiProperty({ example: 'http_request', description: 'A registered handler name.' })
  @IsString()
  @MaxLength(100)
  handler!: string;

  @ApiPropertyOptional({ description: 'Handler input. Validated against the handler schema.' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Caller-defined tags. Not passed to the handler.' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '0-255 (higher runs sooner) or a label: CRITICAL, HIGH, NORMAL, LOW, BULK.',
    example: 150,
  })
  @IsOptional()
  priority?: number | 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW' | 'BULK';

  @ApiPropertyOptional({
    description: 'Run at this instant. Mutually exclusive with delay_seconds. Omit both to run now.',
  })
  @IsOptional()
  @IsISO8601()
  run_at?: string;

  @ApiPropertyOptional({ description: 'Run this many seconds from now.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  delay_seconds?: number;

  @ApiPropertyOptional({ description: 'Overrides the queue retry policy for this job only.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  max_attempts?: number;

  @ApiPropertyOptional({ description: 'Wall-clock limit for one attempt.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  timeout_ms?: number;

  @ApiPropertyOptional({
    description:
      'Opt-in de-duplication, unique per queue. Re-POSTing the same key returns the existing job with 200 instead of creating a second.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string;

  @ApiPropertyOptional({ description: 'Queue the job even if the queue is paused.' })
  @IsOptional()
  @IsBoolean()
  allow_when_paused?: boolean;
}

export class CreateBatchDto {
  @ApiProperty({ type: [CreateJobDto], maxItems: LIMITS.BATCH_MAX_JOBS })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateJobDto)
  jobs!: CreateJobDto[];

  @ApiPropertyOptional({
    description: 'All-or-nothing. When false (default), valid jobs commit and failures are reported per index.',
  })
  @IsOptional()
  @IsBoolean()
  stop_on_error?: boolean;
}

/** Filters for the job explorer. Every one is backed by an index. */
export class ListJobsQuery extends PaginationQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() queue_id?: string;

  @ApiPropertyOptional({
    description: 'Repeatable, or comma-separated.',
    example: 'DEAD_LETTER,FAILED',
  })
  @IsOptional()
  status?: string | string[];

  @ApiPropertyOptional() @IsOptional() @IsString() handler?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() batch_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() scheduled_job_id?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() priority_gte?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() priority_lte?: number;

  @ApiPropertyOptional() @IsOptional() @IsISO8601() created_after?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() created_before?: string;

  @ApiPropertyOptional({ description: 'Job id prefix.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class JobResponse {
  @ApiProperty() id!: string;
  @ApiProperty() queue_id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() handler!: string;
  @ApiProperty() priority!: number;
  @ApiProperty() attempt_count!: number;
  @ApiProperty() max_attempts!: number;
  @ApiProperty() run_at!: string;
  @ApiProperty({ nullable: true }) started_at!: string | null;
  @ApiProperty({ nullable: true }) finished_at!: string | null;
  @ApiProperty({ nullable: true }) last_error_code!: string | null;
  @ApiProperty({ nullable: true }) last_error_message!: string | null;
  @ApiProperty() created_at!: string;
}
