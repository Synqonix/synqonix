import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApiTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  /** Default `["read", "write"]`. `read` alone only allows GET requests. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['read', 'write'], { each: true })
  scopes?: ('read' | 'write')[];

  /** Limit the token to one workspace you belong to. */
  @IsOptional()
  @IsString()
  workspaceId?: string;
}

export class ApiTokenDto {
  id: string;
  name: string;
  /** First characters of the token, to help identify it. */
  prefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  scopes: ('read' | 'write')[];
  /** The workspace the token is limited to, if any. */
  workspaceId: string | null;
}

export class CreatedApiTokenDto extends ApiTokenDto {
  /** The full token. Shown once. */
  token: string;
}
