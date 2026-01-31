import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { PendingApproval, EntityFact } from '@pkg/entities';
import { PendingApprovalService } from './pending-approval.service';

/**
 * Module for pending approval workflow.
 *
 * Provides PendingApprovalService for:
 * - Creating draft entities with pending approval
 * - Approving/rejecting individual items
 * - Batch approve/reject operations
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PendingApproval, EntityFact]),
    ConfigModule,
  ],
  providers: [PendingApprovalService],
  exports: [PendingApprovalService],
})
export class PendingApprovalModule {}
