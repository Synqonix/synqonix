import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RetentionService } from './retention.service.js';

@Module({ imports: [AuthModule], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
