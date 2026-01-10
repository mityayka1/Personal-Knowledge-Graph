import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GroupMembership } from '@pkg/entities';
import { GroupMembershipService } from './group-membership.service';
import { GroupMembershipController } from './group-membership.controller';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GroupMembership]),
    forwardRef(() => EntityModule),
  ],
  controllers: [GroupMembershipController],
  providers: [GroupMembershipService],
  exports: [GroupMembershipService],
})
export class GroupMembershipModule {}
