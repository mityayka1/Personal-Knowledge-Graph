import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import {
  PendingApproval,
  EntityFact,
  Activity,
  Commitment,
} from '@pkg/entities';
import { PendingApprovalService } from './pending-approval.service';
import { PendingApprovalController } from './pending-approval.controller';

/**
 * Module for pending approval workflow.
 *
 * Provides:
 * - PendingApprovalController: REST API for approve/reject operations
 * - PendingApprovalService: Business logic for draft entities + approvals
 *
 * Endpoints:
 * - GET  /pending-approval          - List with filters
 * - GET  /pending-approval/:id      - Get by ID
 * - POST /pending-approval/:id/approve - Approve single
 * - POST /pending-approval/:id/reject  - Reject single
 * - GET  /pending-approval/batch/:batchId/stats  - Batch statistics
 * - POST /pending-approval/batch/:batchId/approve - Approve batch
 * - POST /pending-approval/batch/:batchId/reject  - Reject batch
 *
 * @see docs/plans/2026-01-31-refactor-extraction-carousel-to-pending-facts-plan.md
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PendingApproval, EntityFact, Activity, Commitment]),
    ConfigModule,
  ],
  controllers: [PendingApprovalController],
  providers: [PendingApprovalService],
  exports: [PendingApprovalService],
})
export class PendingApprovalModule {}
