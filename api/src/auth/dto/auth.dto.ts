import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @IsEmail()
  @Transform(normalizeEmail)
  email: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  /** Token from an invitation link sent to this email: the address counts as verified and you are signed in at once. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  invitationToken?: string;
}

export class LoginDto {
  @IsEmail()
  @Transform(normalizeEmail)
  email: string;

  @IsString()
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  /** Only needed by non-browser clients; browsers send the httpOnly cookie. */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  @Transform(normalizeEmail)
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

export class UserDto {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: Date;
}

export class AuthResponseDto {
  user: UserDto;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Only for non-browser clients. Browsers (requests with an Origin header) get it solely as the httpOnly `sx_refresh` cookie. */
  refreshToken?: string;
}

export class SessionDto {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  current: boolean;
}

/** Registration accepted: the account is finished (and signed in) through the emailed link. */
export class VerificationSentDto {
  @ApiProperty({ enum: [true] })
  verificationSent: true;
}

/** The password was right but the account uses 2FA: send a code with `mfaToken` to /auth/login/2fa. */
export class MfaChallengeDto {
  @ApiProperty({ enum: [true] })
  mfaRequired: true;
  /** Valid for 5 minutes. */
  mfaToken: string;
}

export class SecondFactorDto {
  @IsString()
  @MaxLength(2000)
  mfaToken: string;

  /** Six-digit code from the authenticator app, or a recovery code (xxxx-xxxx). */
  @IsString()
  @MaxLength(20)
  code: string;
}

export class TotpCodeDto {
  @IsString()
  @Matches(/^\s*\d{6}\s*$/, { message: 'Enter the six-digit code from your authenticator app' })
  code: string;
}

export class DisableTwoFactorDto {
  @IsString()
  @MaxLength(128)
  password: string;

  /** Code from the authenticator app, or a recovery code. */
  @IsString()
  @MaxLength(20)
  code: string;
}

export class TotpSetupDto {
  /** Base32 secret, for typing into the app by hand. */
  secret: string;
  /** otpauth:// link to show as a QR code. */
  otpauthUrl: string;
}

export class RecoveryCodesDto {
  /** Shown once; each works one time in place of an app code. */
  recoveryCodes: string[];
}

export class TwoFactorStatusDto {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export class VerifyEmailDto {
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  token: string;

  /** The password to set; needed when the link is opened outside the browser that registered. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}

/** The link was opened outside the registering browser: send it again with `password`. It is still unused. */
export class PasswordRequiredDto {
  @ApiProperty({ enum: [true] })
  passwordRequired: true;
}
