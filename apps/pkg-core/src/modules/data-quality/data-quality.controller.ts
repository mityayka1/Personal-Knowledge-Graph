import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  ParseUUIDPipe,
  ValidationPipe,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataQualityService } from './data-quality.service';
import { ResolveIssueDto } from './dto/resolve-issue.dto';
import { MergeActivitiesDto } from './dto/merge-activities.dto';

/**
 * DataQualityController -- REST API for data quality auditing and resolution.
 *
 * Endpoints:
 * - POST   /api/v1/data-quality/audit              -- run full audit
 * - GET    /api/v1/data-quality/reports             -- list reports (paginated)
 * - GET    /api/v1/data-quality/reports/latest      -- latest report
 * - GET    /api/v1/data-quality/reports/:id         -- report by ID
 * - PATCH  /api/v1/data-quality/reports/:id/resolve -- resolve an issue
 * - GET    /api/v1/data-quality/metrics             -- current metrics (no report saved)
 * - POST   /api/v1/data-quality/merge               -- merge duplicate activities
 */
@ApiTags('data-quality')
@Controller('api/v1/data-quality')
export class DataQualityController {
  private readonly logger = new Logger(DataQualityController.name);

  constructor(private readonly dataQualityService: DataQualityService) {}

  /**
   * Run a full data quality audit.
   * Collects metrics, detects issues, and persists a DataQualityReport.
   */
  @Post('audit')
  async runAudit() {
    this.logger.log('Running full data quality audit');
    return this.dataQualityService.runFullAudit();
  }

  /**
   * List data quality reports with pagination.
   */
  @Get('reports')
  async getReports(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.dataQualityService.getReports(
      limit ? Number(limit) : 20,
      offset ? Number(offset) : 0,
    );
  }

  /**
   * Get the latest data quality report.
   *
   * NOTE: This route MUST be declared before `reports/:id`
   * to prevent NestJS from treating "latest" as a UUID parameter.
   */
  @Get('reports/latest')
  async getLatestReport() {
    const report = await this.dataQualityService.getLatestReport();
    if (!report) {
      throw new NotFoundException('No data quality reports found');
    }
    return report;
  }

  /**
   * Get a specific data quality report by ID.
   */
  @Get('reports/:id')
  async getReportById(@Param('id', ParseUUIDPipe) id: string) {
    return this.dataQualityService.getReportById(id);
  }

  /**
   * Resolve an issue in a data quality report.
   */
  @Patch('reports/:id/resolve')
  async resolveIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: ResolveIssueDto,
  ) {
    this.logger.log(
      `Resolving issue #${dto.issueIndex} in report ${id}: ${dto.action}`,
    );
    return this.dataQualityService.resolveIssue(id, dto.issueIndex, dto.action);
  }

  /**
   * Get current data quality metrics without saving a report.
   */
  @Get('metrics')
  async getMetrics() {
    return this.dataQualityService.getCurrentMetrics();
  }

  /**
   * Merge duplicate activities into one.
   */
  @Post('merge')
  async mergeActivities(
    @Body(new ValidationPipe({ whitelist: true })) dto: MergeActivitiesDto,
  ) {
    this.logger.log(
      `Merging ${dto.mergeIds.length} activities into ${dto.keepId}`,
    );
    return this.dataQualityService.mergeActivities(dto.keepId, dto.mergeIds);
  }
}
