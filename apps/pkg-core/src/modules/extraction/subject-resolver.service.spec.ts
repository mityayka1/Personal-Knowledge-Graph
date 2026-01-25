import { Test } from '@nestjs/testing';
import { SubjectResolverService } from './subject-resolver.service';
import { EntityService } from '../entity/entity.service';
import { ConfirmationService } from '../confirmation/confirmation.service';
import { PendingConfirmationType, EntityType, CreationSource } from '@pkg/entities';

describe('SubjectResolverService', () => {
  let service: SubjectResolverService;
  let entityService: jest.Mocked<EntityService>;
  let confirmationService: jest.Mocked<ConfirmationService>;

  const AUTO_RESOLVE_THRESHOLD = 0.8;

  beforeEach(async () => {
    const mockEntityService = {
      findAll: jest.fn(),
    };

    const mockConfirmationService = {
      create: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        SubjectResolverService,
        { provide: EntityService, useValue: mockEntityService },
        { provide: ConfirmationService, useValue: mockConfirmationService },
      ],
    }).compile();

    service = module.get(SubjectResolverService);
    entityService = module.get(EntityService);
    confirmationService = module.get(ConfirmationService);
  });

  /** Helper to create mock entity */
  function createEntity(id: string, name: string) {
    return {
      id,
      name,
      type: EntityType.PERSON,
      organizationId: null,
      organization: null,
      employees: [],
      notes: null,
      profilePhoto: null,
      creationSource: CreationSource.MANUAL,
      isBot: false,
      identifiers: [],
      facts: [],
      participations: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /** Helper to create mock findAll result */
  function createFindAllResult(items: ReturnType<typeof createEntity>[]) {
    return {
      items,
      total: items.length,
      limit: 10,
      offset: 0,
    };
  }

  describe('resolve', () => {
    describe('Case 1: Auto-resolve with single participant match + high confidence', () => {
      it('should auto-resolve when exactly one participant matches with confidence >= 0.8', async () => {
        const entity = createEntity('entity-1', 'Игорь');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        const result = await service.resolve(
          'Игорь',
          ['entity-1'], // This entity is a participant
          0.9, // High confidence
        );

        expect(result.status).toBe('resolved');
        expect(result).toEqual({
          status: 'resolved',
          entityId: 'entity-1',
        });

        // Should NOT create confirmation
        expect(confirmationService.create).not.toHaveBeenCalled();
      });

      it('should auto-resolve at exactly 0.8 confidence threshold', async () => {
        const entity = createEntity('entity-1', 'Мария');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        const result = await service.resolve('Мария', ['entity-1'], AUTO_RESOLVE_THRESHOLD);

        expect(result.status).toBe('resolved');
        expect(result).toHaveProperty('entityId', 'entity-1');
      });
    });

    describe('Case 2: Pending with multiple participant matches', () => {
      it('should create confirmation when multiple participants match', async () => {
        const entities = [
          createEntity('entity-1', 'Иван Петров'),
          createEntity('entity-2', 'Иван Сидоров'),
        ];
        entityService.findAll.mockResolvedValue(createFindAllResult(entities));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-1',
        } as any);

        const result = await service.resolve(
          'Иван',
          ['entity-1', 'entity-2'], // Both are participants
          0.9,
        );

        expect(result.status).toBe('pending');
        expect(result).toHaveProperty('confirmationId', 'confirmation-1');

        expect(confirmationService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            type: PendingConfirmationType.FACT_SUBJECT,
            confidence: 0.9,
          }),
        );
      });
    });

    describe('Case 3: Pending with low confidence', () => {
      it('should create confirmation when confidence < 0.8 even with single match', async () => {
        const entity = createEntity('entity-1', 'Алексей');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-2',
        } as any);

        const result = await service.resolve(
          'Алексей',
          ['entity-1'],
          0.6, // Low confidence
        );

        expect(result.status).toBe('pending');
        expect(result).toHaveProperty('confirmationId', 'confirmation-2');
      });

      it('should create confirmation at 0.79 confidence (just below threshold)', async () => {
        const entity = createEntity('entity-1', 'Дмитрий');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-3',
        } as any);

        const result = await service.resolve('Дмитрий', ['entity-1'], 0.79);

        expect(result.status).toBe('pending');
      });
    });

    describe('Case 4: Pending with non-participant candidates', () => {
      it('should create confirmation when candidates exist but are not participants', async () => {
        const entity = createEntity('entity-1', 'Елена');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-4',
        } as any);

        const result = await service.resolve(
          'Елена',
          ['entity-2'], // Different participant
          0.9,
        );

        expect(result.status).toBe('pending');
        expect(confirmationService.create).toHaveBeenCalled();
      });
    });

    describe('Case 5: Unknown when no matches found', () => {
      it('should return unknown status when no entities match the name', async () => {
        entityService.findAll.mockResolvedValue(createFindAllResult([]));

        const result = await service.resolve('НеизвестноеИмя', ['entity-1'], 0.9);

        expect(result.status).toBe('unknown');
        expect(result).toHaveProperty('suggestedName', 'НеизвестноеИмя');

        // Should NOT create confirmation
        expect(confirmationService.create).not.toHaveBeenCalled();
      });
    });

    describe('Edge cases', () => {
      it('should handle empty name (< 2 chars) gracefully', async () => {
        const result = await service.resolve('И', ['entity-1'], 0.9);

        expect(result.status).toBe('unknown');
        expect(entityService.findAll).not.toHaveBeenCalled();
      });

      it('should handle whitespace-only name', async () => {
        const result = await service.resolve('   ', ['entity-1'], 0.9);

        expect(result.status).toBe('unknown');
        expect(entityService.findAll).not.toHaveBeenCalled();
      });

      it('should handle empty participants array', async () => {
        const entity = createEntity('entity-1', 'Сергей');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-5',
        } as any);

        const result = await service.resolve(
          'Сергей',
          [], // No participants
          0.9,
        );

        // Should create confirmation since no participant matches
        expect(result.status).toBe('pending');
      });

      it('should pass sourcePendingFactId to confirmation', async () => {
        const entity = createEntity('entity-1', 'Анна');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-6',
        } as any);

        await service.resolve('Анна', [], 0.9, 'pending-fact-123', 'Анна сказала...');

        expect(confirmationService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            sourcePendingFactId: 'pending-fact-123',
            context: expect.objectContaining({
              sourceQuote: 'Анна сказала...',
            }),
          }),
        );
      });

      it('should trim whitespace from name before searching', async () => {
        const entity = createEntity('entity-1', 'Ольга');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        await service.resolve('  Ольга  ', ['entity-1'], 0.9);

        expect(entityService.findAll).toHaveBeenCalledWith(
          expect.objectContaining({
            search: 'Ольга',
          }),
        );
      });
    });

    describe('Confirmation options', () => {
      it('should include participant matches first in options', async () => {
        const entities = [
          createEntity('entity-1', 'Андрей'),
          createEntity('entity-2', 'Андрейко'),
        ];
        entityService.findAll.mockResolvedValue(createFindAllResult(entities));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-7',
        } as any);

        await service.resolve(
          'Андрей',
          ['entity-1'], // Only entity-1 is participant
          0.7, // Low confidence to trigger confirmation
        );

        const createCall = confirmationService.create.mock.calls[0][0];
        const options = createCall.options;

        // First option should be the participant
        expect(options[0].entityId).toBe('entity-1');
        expect(options[0].sublabel).toContain('участник');

        // Non-participant should come after
        const nonParticipantOption = options.find((o: any) => o.entityId === 'entity-2');
        expect(nonParticipantOption?.sublabel).toBeUndefined();
      });

      it('should include "Create new" and "Skip" options', async () => {
        const entity = createEntity('entity-1', 'Николай');
        entityService.findAll.mockResolvedValue(createFindAllResult([entity]));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-8',
        } as any);

        await service.resolve('Николай', [], 0.7);

        const createCall = confirmationService.create.mock.calls[0][0];
        const options = createCall.options;

        // Should have "Create new" option
        const createNewOption = options.find((o: any) => o.isCreateNew);
        expect(createNewOption).toBeDefined();
        expect(createNewOption?.label).toContain('Создать');

        // Should have "Skip" option
        const skipOption = options.find((o: any) => o.isDecline);
        expect(skipOption).toBeDefined();
        expect(skipOption?.id).toBe('decline');
      });

      it('should limit options to MAX_CONFIRMATION_OPTIONS (5)', async () => {
        // Create many entities
        const entities = Array.from({ length: 10 }, (_, i) =>
          createEntity(`entity-${i}`, `Иван${i}`),
        );
        entityService.findAll.mockResolvedValue(createFindAllResult(entities));

        confirmationService.create.mockResolvedValue({
          id: 'confirmation-9',
        } as any);

        await service.resolve('Иван', [], 0.7);

        const createCall = confirmationService.create.mock.calls[0][0];
        const options = createCall.options;

        // 5 entity options + "Create new" + "Skip" = 7 total
        const entityOptions = options.filter((o: any) => o.entityId);
        expect(entityOptions.length).toBeLessThanOrEqual(5);
      });
    });
  });
});
