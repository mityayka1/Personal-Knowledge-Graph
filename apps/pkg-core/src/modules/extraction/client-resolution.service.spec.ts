import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityRecord, EntityType } from '@pkg/entities';
import {
  ClientResolutionService,
  ClientResolutionResult,
} from './client-resolution.service';

describe('ClientResolutionService', () => {
  let service: ClientResolutionService;

  // Query builder mock with chainable methods
  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  const mockEntityRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  // --- Test data factories ---

  function makeEntity(
    overrides: Partial<EntityRecord> = {},
  ): EntityRecord {
    return {
      id: 'entity-uuid-1',
      name: 'Test Entity',
      type: EntityType.PERSON,
      organizationId: null,
      organization: null,
      employees: [],
      notes: null,
      profilePhoto: null,
      creationSource: 'manual' as any,
      isBot: false,
      isOwner: false,
      identifiers: [],
      facts: [],
      participations: [],
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-15'),
      deletedAt: null,
      get isDeleted() {
        return this.deletedAt !== null;
      },
      ...overrides,
    } as EntityRecord;
  }

  function makeOrganization(
    overrides: Partial<EntityRecord> = {},
  ): EntityRecord {
    return makeEntity({
      type: EntityType.ORGANIZATION,
      name: 'Acme Corp',
      id: 'org-uuid-1',
      ...overrides,
    });
  }

  const OWNER_ENTITY_ID = 'owner-uuid-000';

  // --- Setup ---

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientResolutionService,
        {
          provide: getRepositoryToken(EntityRecord),
          useValue: mockEntityRepo,
        },
      ],
    }).compile();

    service = module.get<ClientResolutionService>(ClientResolutionService);

    jest.clearAllMocks();

    // Restore chaining after clearAllMocks
    mockQueryBuilder.where.mockReturnThis();
    mockQueryBuilder.andWhere.mockReturnThis();
    mockQueryBuilder.orderBy.mockReturnThis();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // =========================================================================
  // findEntityByName
  // =========================================================================

  describe('findEntityByName', () => {
    it('should return null for empty string', async () => {
      const result = await service.findEntityByName('');
      expect(result).toBeNull();
      expect(mockEntityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return null for whitespace-only string', async () => {
      const result = await service.findEntityByName('   ');
      expect(result).toBeNull();
      expect(mockEntityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return null for null input', async () => {
      const result = await service.findEntityByName(null as any);
      expect(result).toBeNull();
    });

    it('should return null for undefined input', async () => {
      const result = await service.findEntityByName(undefined as any);
      expect(result).toBeNull();
    });

    it('should return exact match when found', async () => {
      const entity = makeEntity({ name: 'Alice' });
      mockQueryBuilder.getOne.mockResolvedValueOnce(entity);

      const result = await service.findEntityByName('Alice');

      expect(result).toBe(entity);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'LOWER(e.name) = LOWER(:name)',
        { name: 'Alice' },
      );
      // Should not attempt partial match since exact match was found
      expect(mockEntityRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should fall back to partial match when exact match not found', async () => {
      const entity = makeEntity({ name: 'Alice Johnson' });
      // First call (exact match) returns null
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);
      // Second call (partial match) returns entity
      mockQueryBuilder.getOne.mockResolvedValueOnce(entity);

      const result = await service.findEntityByName('Alice');

      expect(result).toBe(entity);
      expect(mockEntityRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      // Second query builder call should use ILIKE pattern
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'e.name ILIKE :pattern',
        { pattern: '%Alice%' },
      );
    });

    it('should return null when neither exact nor partial match found', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      const result = await service.findEntityByName('NonExistent');

      expect(result).toBeNull();
      expect(mockEntityRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('should trim input name before searching', async () => {
      const entity = makeEntity({ name: 'Alice' });
      mockQueryBuilder.getOne.mockResolvedValueOnce(entity);

      await service.findEntityByName('  Alice  ');

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'LOWER(e.name) = LOWER(:name)',
        { name: 'Alice' },
      );
    });

    it('should order results by updatedAt DESC', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findEntityByName('Test');

      // Both exact and partial queries should use the same ordering
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('e.updatedAt', 'DESC');
    });
  });

  // =========================================================================
  // findOrganizationsAmong
  // =========================================================================

  describe('findOrganizationsAmong', () => {
    it('should return empty array for empty names list', async () => {
      const result = await service.findOrganizationsAmong([]);
      expect(result).toEqual([]);
      expect(mockEntityRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return empty array for null names', async () => {
      const result = await service.findOrganizationsAmong(null as any);
      expect(result).toEqual([]);
    });

    it('should return empty array for undefined names', async () => {
      const result = await service.findOrganizationsAmong(undefined as any);
      expect(result).toEqual([]);
    });

    it('should find organization matching a participant name', async () => {
      const org = makeOrganization({ name: 'Acme Corp' });
      mockQueryBuilder.getOne.mockResolvedValueOnce(org);

      const result = await service.findOrganizationsAmong(['Acme Corp']);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(org);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'e.type = :orgType',
        { orgType: EntityType.ORGANIZATION },
      );
    });

    it('should filter by organization type', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findOrganizationsAmong(['SomeName']);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'e.type = :orgType',
        { orgType: EntityType.ORGANIZATION },
      );
    });

    it('should use both exact and ILIKE match in query', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findOrganizationsAmong(['Acme']);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(LOWER(e.name) = LOWER(:exactName) OR e.name ILIKE :pattern)',
        { exactName: 'Acme', pattern: '%Acme%' },
      );
    });

    it('should exclude entity by excludeEntityId', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findOrganizationsAmong(['Acme'], 'exclude-uuid');

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'e.id != :excludeId',
        { excludeId: 'exclude-uuid' },
      );
    });

    it('should not add exclude clause when excludeEntityId is undefined', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findOrganizationsAmong(['Acme']);

      // andWhere called once for the name match, NOT for exclude
      const excludeCall = mockQueryBuilder.andWhere.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('excludeId'),
      );
      expect(excludeCall).toBeUndefined();
    });

    it('should deduplicate organizations found by multiple names', async () => {
      const org = makeOrganization({ id: 'org-uuid-same', name: 'Acme Corp' });
      // Both names find the same organization
      mockQueryBuilder.getOne.mockResolvedValueOnce(org);
      mockQueryBuilder.getOne.mockResolvedValueOnce(org);

      const result = await service.findOrganizationsAmong([
        'Acme Corp',
        'Acme',
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('org-uuid-same');
    });

    it('should return multiple different organizations', async () => {
      const org1 = makeOrganization({ id: 'org-1', name: 'Acme Corp' });
      const org2 = makeOrganization({ id: 'org-2', name: 'Beta Inc' });
      mockQueryBuilder.getOne.mockResolvedValueOnce(org1);
      mockQueryBuilder.getOne.mockResolvedValueOnce(org2);

      const result = await service.findOrganizationsAmong([
        'Acme Corp',
        'Beta Inc',
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('org-1');
      expect(result[1].id).toBe('org-2');
    });

    it('should skip empty and whitespace-only names', async () => {
      const org = makeOrganization();
      mockQueryBuilder.getOne.mockResolvedValueOnce(org);

      await service.findOrganizationsAmong(['', '  ', 'Acme Corp']);

      // createQueryBuilder called only once (for 'Acme Corp')
      expect(mockEntityRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should trim names before searching', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findOrganizationsAmong(['  Acme Corp  ']);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        '(LOWER(e.name) = LOWER(:exactName) OR e.name ILIKE :pattern)',
        { exactName: 'Acme Corp', pattern: '%Acme Corp%' },
      );
    });

    it('should order by updatedAt DESC', async () => {
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);

      await service.findOrganizationsAmong(['Test']);

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('e.updatedAt', 'DESC');
    });
  });

  // =========================================================================
  // resolveClient
  // =========================================================================

  describe('resolveClient', () => {
    // Helper to spy on internal methods
    let findEntityByNameSpy: jest.SpyInstance;
    let findOrganizationsAmongSpy: jest.SpyInstance;

    beforeEach(() => {
      findEntityByNameSpy = jest.spyOn(service, 'findEntityByName');
      findOrganizationsAmongSpy = jest.spyOn(service, 'findOrganizationsAmong');
    });

    // -----------------------------------------------------------------------
    // Strategy 1: Explicit client name
    // -----------------------------------------------------------------------

    describe('Strategy 1: explicit client name', () => {
      it('should resolve via explicit client name when entity found', async () => {
        const entity = makeEntity({ id: 'client-uuid', name: 'ClientCo' });
        findEntityByNameSpy.mockResolvedValueOnce(entity);

        const result = await service.resolveClient({
          clientName: 'ClientCo',
          participants: ['Alice', 'Bob'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toEqual<ClientResolutionResult>({
          entityId: 'client-uuid',
          entityName: 'ClientCo',
          method: 'explicit',
        });
        // Should not proceed to other strategies
        expect(findOrganizationsAmongSpy).not.toHaveBeenCalled();
      });

      it('should skip explicit match when entity id equals ownerEntityId', async () => {
        const ownerEntity = makeEntity({
          id: OWNER_ENTITY_ID,
          name: 'My Company',
        });
        findEntityByNameSpy.mockResolvedValueOnce(ownerEntity);
        // Strategy 2: no orgs found
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: no name match
        findEntityByNameSpy.mockResolvedValueOnce(null);
        findEntityByNameSpy.mockResolvedValueOnce(null);

        const result = await service.resolveClient({
          clientName: 'My Company',
          participants: ['Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        // Should have fallen through to other strategies
        expect(findOrganizationsAmongSpy).toHaveBeenCalled();
      });

      it('should fall through when explicit name does not match any entity', async () => {
        findEntityByNameSpy.mockResolvedValueOnce(null);
        // Strategy 2
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3 - also no match
        findEntityByNameSpy.mockResolvedValueOnce(null);

        const result = await service.resolveClient({
          clientName: 'UnknownCo',
          participants: ['Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(findOrganizationsAmongSpy).toHaveBeenCalledWith(
          ['Alice'],
          OWNER_ENTITY_ID,
        );
      });
    });

    // -----------------------------------------------------------------------
    // Strategy 2: Participant organizations
    // -----------------------------------------------------------------------

    describe('Strategy 2: participant organizations', () => {
      it('should resolve via participant organization', async () => {
        const org = makeOrganization({ id: 'org-uuid', name: 'Acme Corp' });
        // No explicit clientName
        findOrganizationsAmongSpy.mockResolvedValueOnce([org]);

        const result = await service.resolveClient({
          participants: ['Acme Corp', 'Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toEqual<ClientResolutionResult>({
          entityId: 'org-uuid',
          entityName: 'Acme Corp',
          method: 'participant_org',
        });
      });

      it('should pick the first organization when multiple found', async () => {
        const org1 = makeOrganization({ id: 'org-1', name: 'First Corp' });
        const org2 = makeOrganization({ id: 'org-2', name: 'Second Corp' });
        findOrganizationsAmongSpy.mockResolvedValueOnce([org1, org2]);

        const result = await service.resolveClient({
          participants: ['First Corp', 'Second Corp'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.entityId).toBe('org-1');
        expect(result!.method).toBe('participant_org');
      });

      it('should pass ownerEntityId to findOrganizationsAmong for exclusion', async () => {
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3 fallback
        findEntityByNameSpy.mockResolvedValueOnce(null);

        await service.resolveClient({
          participants: ['TestOrg'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(findOrganizationsAmongSpy).toHaveBeenCalledWith(
          ['TestOrg'],
          OWNER_ENTITY_ID,
        );
      });

      it('should skip strategy 2 when participants is empty', async () => {
        const result = await service.resolveClient({
          participants: [],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(findOrganizationsAmongSpy).not.toHaveBeenCalled();
        expect(result).toBeNull();
      });

      it('should skip strategy 2 when participants is undefined', async () => {
        const result = await service.resolveClient({
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(findOrganizationsAmongSpy).not.toHaveBeenCalled();
        expect(result).toBeNull();
      });

      it('should fall through to strategy 3 when no organizations found', async () => {
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        const person = makeEntity({ id: 'person-uuid', name: 'Alice' });
        findEntityByNameSpy.mockResolvedValueOnce(person);

        const result = await service.resolveClient({
          participants: ['Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.method).toBe('name_search');
      });
    });

    // -----------------------------------------------------------------------
    // Strategy 3: Name search fallback
    // -----------------------------------------------------------------------

    describe('Strategy 3: name search fallback', () => {
      it('should resolve via name search when strategies 1 and 2 fail', async () => {
        const person = makeEntity({ id: 'person-uuid', name: 'Alice Smith' });
        // Strategy 2: no orgs
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: first participant matches
        findEntityByNameSpy.mockResolvedValueOnce(person);

        const result = await service.resolveClient({
          participants: ['Alice Smith'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toEqual<ClientResolutionResult>({
          entityId: 'person-uuid',
          entityName: 'Alice Smith',
          method: 'name_search',
        });
      });

      it('should try each participant name until one matches', async () => {
        const bob = makeEntity({ id: 'bob-uuid', name: 'Bob' });
        // Strategy 2: no orgs
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: first name no match, second matches
        findEntityByNameSpy.mockResolvedValueOnce(null);
        findEntityByNameSpy.mockResolvedValueOnce(bob);

        const result = await service.resolveClient({
          participants: ['Unknown Person', 'Bob'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.entityId).toBe('bob-uuid');
        expect(result!.method).toBe('name_search');
        // findEntityByName called twice for strategy 3
        expect(findEntityByNameSpy).toHaveBeenCalledWith('Unknown Person');
        expect(findEntityByNameSpy).toHaveBeenCalledWith('Bob');
      });

      it('should skip participant whose entity id matches ownerEntityId', async () => {
        const ownerEntity = makeEntity({
          id: OWNER_ENTITY_ID,
          name: 'Owner',
        });
        const alice = makeEntity({ id: 'alice-uuid', name: 'Alice' });
        // Strategy 2: no orgs
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: first participant is owner, second is real match
        findEntityByNameSpy.mockResolvedValueOnce(ownerEntity);
        findEntityByNameSpy.mockResolvedValueOnce(alice);

        const result = await service.resolveClient({
          participants: ['Owner', 'Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.entityId).toBe('alice-uuid');
        expect(result!.method).toBe('name_search');
      });

      it('should return null when no participant name matches', async () => {
        // Strategy 2: no orgs
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: no matches
        findEntityByNameSpy.mockResolvedValueOnce(null);
        findEntityByNameSpy.mockResolvedValueOnce(null);

        const result = await service.resolveClient({
          participants: ['Nobody1', 'Nobody2'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toBeNull();
      });

      it('should return null when all participants match ownerEntityId', async () => {
        const ownerEntity = makeEntity({
          id: OWNER_ENTITY_ID,
          name: 'Owner',
        });
        // Strategy 2: no orgs
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: all matches are owner
        findEntityByNameSpy.mockResolvedValueOnce(ownerEntity);

        const result = await service.resolveClient({
          participants: ['Owner'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    describe('edge cases', () => {
      it('should return null when all parameters are minimal', async () => {
        const result = await service.resolveClient({
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toBeNull();
      });

      it('should return null with empty clientName and empty participants', async () => {
        const result = await service.resolveClient({
          clientName: '',
          participants: [],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toBeNull();
      });

      it('should skip strategy 1 when clientName is undefined', async () => {
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        findEntityByNameSpy.mockResolvedValueOnce(null);

        await service.resolveClient({
          clientName: undefined,
          participants: ['Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        // findEntityByName should only be called by strategy 3 (for 'Alice'),
        // not by strategy 1
        expect(findEntityByNameSpy).toHaveBeenCalledTimes(1);
        expect(findEntityByNameSpy).toHaveBeenCalledWith('Alice');
      });

      it('should skip strategy 1 when clientName is empty string', async () => {
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        findEntityByNameSpy.mockResolvedValueOnce(null);

        await service.resolveClient({
          clientName: '',
          participants: ['Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        // Strategy 1 skipped because '' is falsy
        // Only strategy 3 calls findEntityByName
        expect(findEntityByNameSpy).toHaveBeenCalledTimes(1);
        expect(findEntityByNameSpy).toHaveBeenCalledWith('Alice');
      });

      it('should execute all strategies in priority order', async () => {
        const callOrder: string[] = [];

        findEntityByNameSpy.mockImplementation(async (name: string) => {
          callOrder.push(`findEntityByName:${name}`);
          return null;
        });
        findOrganizationsAmongSpy.mockImplementation(async () => {
          callOrder.push('findOrganizationsAmong');
          return [];
        });

        await service.resolveClient({
          clientName: 'ExplicitClient',
          participants: ['Alice', 'Bob'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(callOrder).toEqual([
          'findEntityByName:ExplicitClient',  // Strategy 1
          'findOrganizationsAmong',            // Strategy 2
          'findEntityByName:Alice',            // Strategy 3, first participant
          'findEntityByName:Bob',              // Strategy 3, second participant
        ]);
      });

      it('should short-circuit at strategy 1 when match found', async () => {
        const entity = makeEntity({ id: 'match-uuid', name: 'Match' });
        findEntityByNameSpy.mockResolvedValueOnce(entity);

        const result = await service.resolveClient({
          clientName: 'Match',
          participants: ['Alice', 'Bob'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.method).toBe('explicit');
        // Strategy 2 and 3 never called
        expect(findOrganizationsAmongSpy).not.toHaveBeenCalled();
        // findEntityByName called only once (for strategy 1)
        expect(findEntityByNameSpy).toHaveBeenCalledTimes(1);
      });

      it('should short-circuit at strategy 2 when organization found', async () => {
        const org = makeOrganization({ id: 'org-uuid', name: 'Corp' });
        // Strategy 1 skipped (no clientName)
        findOrganizationsAmongSpy.mockResolvedValueOnce([org]);

        const result = await service.resolveClient({
          participants: ['Corp', 'Alice'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.method).toBe('participant_org');
        // Strategy 3 findEntityByName not called
        expect(findEntityByNameSpy).not.toHaveBeenCalled();
      });

      it('should short-circuit at first matching participant in strategy 3', async () => {
        const alice = makeEntity({ id: 'alice-uuid', name: 'Alice' });
        // Strategy 2: no orgs
        findOrganizationsAmongSpy.mockResolvedValueOnce([]);
        // Strategy 3: first participant matches
        findEntityByNameSpy.mockResolvedValueOnce(alice);

        const result = await service.resolveClient({
          participants: ['Alice', 'Bob', 'Charlie'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result!.entityId).toBe('alice-uuid');
        // findEntityByName should only be called once (for 'Alice')
        expect(findEntityByNameSpy).toHaveBeenCalledTimes(1);
        expect(findEntityByNameSpy).not.toHaveBeenCalledWith('Bob');
        expect(findEntityByNameSpy).not.toHaveBeenCalledWith('Charlie');
      });
    });

    // -----------------------------------------------------------------------
    // Full resolution flow (integration-style with real query builder mocks)
    // -----------------------------------------------------------------------

    describe('full resolution flow (without spies)', () => {
      beforeEach(() => {
        // Restore original implementations to test through real query builder mocks
        findEntityByNameSpy.mockRestore();
        findOrganizationsAmongSpy.mockRestore();
      });

      it('should resolve explicit client name via query builder', async () => {
        const entity = makeEntity({ id: 'real-uuid', name: 'RealCo' });
        // Exact match found on first query builder call
        mockQueryBuilder.getOne.mockResolvedValueOnce(entity);

        const result = await service.resolveClient({
          clientName: 'RealCo',
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toEqual({
          entityId: 'real-uuid',
          entityName: 'RealCo',
          method: 'explicit',
        });
      });

      it('should return null when query builder returns nothing for all strategies', async () => {
        // All getOne calls return null
        mockQueryBuilder.getOne.mockResolvedValue(null);

        const result = await service.resolveClient({
          clientName: 'NoMatch',
          participants: ['NoOne'],
          ownerEntityId: OWNER_ENTITY_ID,
        });

        expect(result).toBeNull();
      });
    });
  });
});
