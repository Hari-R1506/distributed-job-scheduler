import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public, Principal } from '../../common/guards.js';
import { AppError, ERROR_CODES } from '../../common/errors.js';
import { HttpStatus } from '@nestjs/common';
import { AuthService, type AuthPrincipal } from './auth.service.js';
import { PrismaService } from '../../prisma.service.js';

class RegisterDto {
  @ApiProperty() @IsEmail() email!: string;
  // 12 chars, checked against length only. A full breached-password check would
  // be the right thing in production; it is out of scope here and said so.
  @ApiProperty({ minLength: 12 }) @IsString() @MinLength(12) @MaxLength(200) password!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(64) org_name!: string;
}

class LoginDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() password!: string;
}

const REFRESH_COOKIE = 'djs_refresh';

/**
 * The access token is returned in the BODY (the SPA holds it in memory) and the
 * refresh token is set as an httpOnly cookie the browser cannot read.
 *
 * Putting the access token in localStorage is the common shortcut and it is
 * XSS-exposed — any injected script can read it. See ARCHITECTURE.md §29.6.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and its first organization' })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { user, org } = await this.auth.register({
      email: dto.email,
      password: dto.password,
      name: dto.name,
      orgName: dto.org_name,
    });
    const tokens = await this.auth.issueTokens(user.id, user.email);
    setRefreshCookie(res, tokens.refreshToken);
    return {
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: org.id, name: org.name, slug: org.slug },
      access_token: tokens.accessToken,
      expires_in: tokens.expiresIn,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for an access token' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.validateCredentials(dto.email, dto.password);
    const tokens = await this.auth.issueTokens(user.id, user.email);
    setRefreshCookie(res, tokens.refreshToken);
    return {
      user: { id: user.id, email: user.email, name: user.name },
      access_token: tokens.accessToken,
      expires_in: tokens.expiresIn,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and mint a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'No refresh token present',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const tokens = await this.auth.refresh(token);
    setRefreshCookie(res, tokens.refreshToken);
    return { access_token: tokens.accessToken, expires_in: tokens.expiresIn };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Get('me')
  @ApiOperation({ summary: 'The current principal and its memberships' })
  async me(@Principal() principal: AuthPrincipal) {
    if (principal.kind === 'api_key') {
      return { kind: 'api_key', project_id: principal.projectId, scopes: principal.scopes };
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        email: true,
        name: true,
        lastLoginAt: true,
        memberships: {
          select: { role: true, org: { select: { id: true, name: true, slug: true } } },
        },
      },
    });
    return {
      kind: 'user',
      user: { id: user.id, email: user.email, name: user.name, last_login_at: user.lastLoginAt },
      memberships: user.memberships.map((m) => ({ role: m.role, org: m.org })),
    };
  }
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Unreachable from JavaScript, so XSS cannot exfiltrate it.
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    // Scoped to the auth routes: no other endpoint has any use for it.
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
