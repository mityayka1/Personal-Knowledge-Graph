import { Controller, Post, Body } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchQuery } from '@pkg/shared';

@Controller('search')
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Post()
  async search(@Body() query: SearchQuery) {
    return this.searchService.search(query);
  }
}
