import { Controller, Post, Body } from '@nestjs/common';
import { ContextService } from './context.service';
import { ContextRequest } from '@pkg/shared';

@Controller('context')
export class ContextController {
  constructor(private contextService: ContextService) {}

  @Post()
  async generateContext(@Body() request: ContextRequest) {
    return this.contextService.generateContext(request);
  }
}
