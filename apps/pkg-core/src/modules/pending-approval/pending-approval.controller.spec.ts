import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PendingApprovalController } from './pending-approval.controller';
import { PendingApprovalService } from './pending-approval.service';
import {
  PendingApprovalItemType,
  PendingApprovalStatus,
} from '@pkg/entities';

describe('PendingApprovalController', () => {
  let controller: PendingApprovalController;
  let service: jest.Mocked<PendingApprovalService>;

  const mockApproval = {
    id: 'approval-uuid-1',
    itemType: PendingApprovalItemType.PROJECT,
    targetId: 'project-uuid-1',
    batchId: 'batch-uuid-1',
    status: PendingApprovalStatus.PENDING,
    confidence: 0.9,
    sourceQuote: 'Test quote',
    sourceInteractionId: 'interaction-uuid-1',
    messageRef: 'telegram:chat:123:msg:456',
    createdAt: new Date(),
    reviewedAt: null,
  };

  const mockService = {
    list: jest.fn(),
    getById: jest.fn(),
    getBatchStats: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
    approveBatch: jest.fn(),
    rejectBatch: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PendingApprovalController],
      providers: [
        {
          provide: PendingApprovalService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<PendingApprovalController>(PendingApprovalController);
    service = module.get(PendingApprovalService);
  });

  describe('list', () => {
    it('should return paginated list with defaults', async () => {
      mockService.list.mockResolvedValue({
        items: [mockApproval],
        total: 1,
      });

      const result = await controller.list({});

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
      expect(mockService.list).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
      });
    });

    it('should filter by batchId', async () => {
      mockService.list.mockResolvedValue({ items: [], total: 0 });

      await controller.list({ batchId: 'batch-uuid-1' });

      expect(mockService.list).toHaveBeenCalledWith({
        batchId: 'batch-uuid-1',
        limit: 50,
        offset: 0,
      });
    });

    it('should filter by status', async () => {
      mockService.list.mockResolvedValue({ items: [], total: 0 });

      await controller.list({ status: PendingApprovalStatus.PENDING });

      expect(mockService.list).toHaveBeenCalledWith({
        status: PendingApprovalStatus.PENDING,
        limit: 50,
        offset: 0,
      });
    });

    it('should clamp limit to max 100', async () => {
      mockService.list.mockResolvedValue({ items: [], total: 0 });

      const result = await controller.list({ limit: '500' });

      expect(result.limit).toBe(100);
      expect(mockService.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('should clamp offset to min 0', async () => {
      mockService.list.mockResolvedValue({ items: [], total: 0 });

      const result = await controller.list({ offset: '-10' });

      expect(result.offset).toBe(0);
    });
  });

  describe('getById', () => {
    it('should return approval when found', async () => {
      mockService.getById.mockResolvedValue(mockApproval);

      const result = await controller.getById('approval-uuid-1');

      expect(result.id).toBe('approval-uuid-1');
      expect(mockService.getById).toHaveBeenCalledWith('approval-uuid-1');
    });

    it('should throw NotFoundException when not found', async () => {
      mockService.getById.mockResolvedValue(null);

      await expect(controller.getById('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getBatchStats', () => {
    it('should return batch statistics', async () => {
      mockService.getBatchStats.mockResolvedValue({
        total: 10,
        pending: 5,
        approved: 3,
        rejected: 2,
      });

      const result = await controller.getBatchStats('batch-uuid-1');

      expect(result).toEqual({
        batchId: 'batch-uuid-1',
        total: 10,
        pending: 5,
        approved: 3,
        rejected: 2,
      });
    });
  });

  describe('approve', () => {
    it('should approve and return success', async () => {
      mockService.approve.mockResolvedValue(undefined);

      const result = await controller.approve('approval-uuid-1');

      expect(result).toEqual({ success: true, id: 'approval-uuid-1' });
      expect(mockService.approve).toHaveBeenCalledWith('approval-uuid-1');
    });
  });

  describe('reject', () => {
    it('should reject and return success', async () => {
      mockService.reject.mockResolvedValue(undefined);

      const result = await controller.reject('approval-uuid-1');

      expect(result).toEqual({ success: true, id: 'approval-uuid-1' });
      expect(mockService.reject).toHaveBeenCalledWith('approval-uuid-1');
    });
  });

  describe('approveBatch', () => {
    it('should approve batch and return result', async () => {
      mockService.approveBatch.mockResolvedValue({
        processed: 5,
        failed: 1,
        errors: ['Target not found'],
      });

      const result = await controller.approveBatch('batch-uuid-1');

      expect(result).toEqual({
        batchId: 'batch-uuid-1',
        processed: 5,
        failed: 1,
        errors: ['Target not found'],
      });
      expect(mockService.approveBatch).toHaveBeenCalledWith('batch-uuid-1');
    });
  });

  describe('rejectBatch', () => {
    it('should reject batch and return result', async () => {
      mockService.rejectBatch.mockResolvedValue({
        processed: 5,
        failed: 0,
      });

      const result = await controller.rejectBatch('batch-uuid-1');

      expect(result).toEqual({
        batchId: 'batch-uuid-1',
        processed: 5,
        failed: 0,
      });
      expect(mockService.rejectBatch).toHaveBeenCalledWith('batch-uuid-1');
    });
  });
});
