import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, Public, RequiresSession } from '../common/decorators.js';
import type { AuthUser } from '../common/decorators.js';
import { AuthService, ClientInfo, type IssuedTokens } from './auth.service.js';
import {
  AuthResponseDto, ChangePasswordDto, DisableTwoFactorDto, ForgotPasswordDto, LoginDto, MfaChallengeDto, RecoveryCodesDto,
  PasswordRequiredDto, RefreshDto, RegisterDto, ResetPasswordDto, SecondFactorDto, SessionDto, TotpCodeDto, TotpSetupDto,
  TwoFactorStatusDto, VerificationSentDto, VerifyEmailDto,
} from './dto/auth.dto.js';
import { TwoFactorService } from './two-factor.service.js';

export const REFRESH_COOKIE = 'sx_refresh';
/** Random per-browser id, so a sign-in from a device the account never used can be announced by email. */
export const DEVICE_COOKIE = 'sx_device';
/** Set by registration in the registering browser; see AuthService.verifyEmail. */
export const REGISTRATION_COOKIE = 'sx_registration';
const COOKIE_PATH = '/api/v1/auth';
const oneOf = (...models: (new () => unknown)[]) => ({ oneOf: models.map((m) => ({ $ref: getSchemaPath(m) })) });
const STRICT = { default: { limit: 10, ttl: 60_000 } };

const clientInfo = (req: Request): ClientInfo => ({
  userAgent: req.headers['user-agent'],
  ip: req.ip,
  deviceId: typeof req.cookies?.[DEVICE_COOKIE] === 'string' ? req.cookies[DEVICE_COOKIE] : undefined,
});

@ApiTags('auth')
@ApiExtraModels(AuthResponseDto, VerificationSentDto, MfaChallengeDto, PasswordRequiredDto)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: COOKIE_PATH,
      maxAge: this.auth.refreshMaxAgeMs,
    });
  }

  private setDeviceCookie(res: Response, deviceId: string) {
    res.cookie(DEVICE_COOKIE, deviceId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: COOKIE_PATH,
      maxAge: 2 * 365 * 24 * 3600_000,
    });
  }

  /**
   * Sets the refresh cookie. Browsers (requests carrying an Origin header) get the refresh token
   * only as that httpOnly cookie, so page scripts can never read it; other clients also get it in
   * the body.
   */
  private respond(req: Request, res: Response, body: IssuedTokens): AuthResponseDto {
    this.setRefreshCookie(res, body.refreshToken);
    const { deviceId, ...tokens } = body;
    if (deviceId) this.setDeviceCookie(res, deviceId);
    if (req.headers.origin === undefined) return tokens;
    const { refreshToken: _cookieOnly, ...rest } = tokens;
    return rest;
  }

  /** Answers "check your inbox" whether or not the email has an account; an invitation link signs in at once. */
  @Public() @Throttle(STRICT)
  @Post('register')
  @ApiCreatedResponse({ schema: oneOf(VerificationSentDto, AuthResponseDto) })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<VerificationSentDto | AuthResponseDto> {
    const result = await this.auth.register(dto, clientInfo(req));
    if (!('verificationSent' in result)) return this.respond(req, res, result);
    // Lets the emailed link apply this password when it is opened in this browser.
    res.cookie(REGISTRATION_COOKIE, result.nonce, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: COOKIE_PATH, maxAge: 24 * 3600_000,
    });
    return { verificationSent: true };
  }

  /** Signs in, or asks for a 2FA code (`mfaRequired`). Unverified accounts get 403 `EMAIL_NOT_VERIFIED`. */
  @Public() @Throttle(STRICT)
  @Post('login') @HttpCode(200)
  @ApiOkResponse({ schema: oneOf(AuthResponseDto, MfaChallengeDto) })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto | MfaChallengeDto> {
    const result = await this.auth.login(dto, clientInfo(req));
    return 'mfaRequired' in result ? result : this.respond(req, res, result);
  }

  @Public() @Throttle(STRICT)
  @Post('login/2fa') @HttpCode(200)
  @ApiOkResponse({ type: AuthResponseDto })
  async loginSecondFactor(@Body() dto: SecondFactorDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(req, res, await this.auth.loginWithSecondFactor(dto.mfaToken, dto.code, clientInfo(req)));
  }

  @Public() @Throttle(STRICT)
  @Post('refresh') @HttpCode(200)
  @ApiOkResponse({ type: AuthResponseDto })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = dto.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    return this.respond(req, res, await this.auth.refresh(token));
  }

  @Public()
  @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(dto.refreshToken ?? req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @Public() @Throttle(STRICT)
  /**
   * Uses a verification link and signs in. Opened outside the registering browser it answers
   * `passwordRequired` (the link stays unused) until called again with the password to set.
   */
  @Post('verify-email') @HttpCode(200)
  @ApiOkResponse({ schema: oneOf(AuthResponseDto, PasswordRequiredDto) })
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponseDto | PasswordRequiredDto> {
    const nonce = req.cookies?.[REGISTRATION_COOKIE];
    const result = await this.auth.verifyEmail(dto.token, clientInfo(req), { nonce: typeof nonce === 'string' ? nonce : undefined, password: dto.password });
    if ('passwordRequired' in result) return result;
    res.clearCookie(REGISTRATION_COOKIE, { path: COOKIE_PATH });
    return this.respond(req, res, result);
  }

  @ApiBearerAuth() @Throttle(STRICT)
  @Post('resend-verification') @HttpCode(204)
  resendVerification(@CurrentUser() user: AuthUser) {
    return this.auth.resendVerification(user.id);
  }

  @Public() @Throttle(STRICT)
  @Post('forgot-password') @HttpCode(204)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public() @Throttle(STRICT)
  @Post('reset-password') @HttpCode(204)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  @ApiBearerAuth() @RequiresSession() @Throttle(STRICT)
  @Post('change-password') @HttpCode(204)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, user.sessionId, dto.currentPassword, dto.newPassword);
  }

  @ApiBearerAuth() @RequiresSession()
  @Get('sessions')
  @ApiOkResponse({ type: [SessionDto] })
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @ApiBearerAuth() @RequiresSession()
  @Delete('sessions/:id') @HttpCode(204)
  revokeSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.auth.revokeUserSession(user.id, id);
  }

  // ---------- two-factor authentication ----------

  @ApiBearerAuth() @RequiresSession()
  @Get('2fa')
  @ApiOkResponse({ type: TwoFactorStatusDto })
  async twoFactorStatus(@CurrentUser() user: AuthUser): Promise<TwoFactorStatusDto> {
    return { enabled: (await this.auth.me(user.id)).twoFactorEnabled, recoveryCodesLeft: await this.twoFactor.remainingRecoveryCodes(user.id) };
  }

  @ApiBearerAuth() @RequiresSession() @Throttle(STRICT)
  @Post('2fa/setup') @HttpCode(200)
  @ApiOkResponse({ type: TotpSetupDto })
  setupTwoFactor(@CurrentUser() user: AuthUser) {
    return this.twoFactor.setup(user.id);
  }

  @ApiBearerAuth() @RequiresSession() @Throttle(STRICT)
  @Post('2fa/enable') @HttpCode(200)
  @ApiOkResponse({ type: RecoveryCodesDto })
  enableTwoFactor(@CurrentUser() user: AuthUser, @Body() dto: TotpCodeDto) {
    return this.twoFactor.enable(user.id, dto.code.trim());
  }

  @ApiBearerAuth() @RequiresSession() @Throttle(STRICT)
  @Post('2fa/disable') @HttpCode(204)
  disableTwoFactor(@CurrentUser() user: AuthUser, @Body() dto: DisableTwoFactorDto) {
    return this.twoFactor.disable(user.id, dto.password, dto.code);
  }

  @ApiBearerAuth() @RequiresSession() @Throttle(STRICT)
  @Post('2fa/recovery-codes') @HttpCode(200)
  @ApiOkResponse({ type: RecoveryCodesDto })
  regenerateRecoveryCodes(@CurrentUser() user: AuthUser, @Body() dto: TotpCodeDto) {
    return this.twoFactor.regenerateRecoveryCodes(user.id, dto.code.trim());
  }
}
