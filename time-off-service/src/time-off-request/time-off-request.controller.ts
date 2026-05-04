import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBody, ApiResponse } from '@nestjs/swagger';
import { TimeOffRequestService } from './time-off-request.service';
import { CreateTimeOffRequestDto, RejectRequestDto } from './dto/time-off-request.dto';
import { RequestStatus } from '../common/enums';

@ApiTags('time-off-requests')
@Controller('time-off-requests')
export class TimeOffRequestController {
  constructor(private readonly requestService: TimeOffRequestService) {}

  @Post()
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  @ApiOperation({ summary: 'Create a time-off request' })
  @ApiBody({ type: CreateTimeOffRequestDto })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 400, description: 'Validation error or insufficient balance' })
  async create(@Body() dto: CreateTimeOffRequestDto) {
    return this.requestService.create(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a request by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  async findById(@Param('id') id: string) {
    return this.requestService.findById(id);
  }

  @Get()
  @ApiOperation({ summary: 'List requests with optional filters' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: RequestStatus })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiResponse({ status: 200 })
  async findAll(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: RequestStatus,
    @Query('locationId') locationId?: string,
  ) {
    return this.requestService.findAll({ employeeId, status, locationId });
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approve a request (triggers HCM submission)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'HCM unavailable or balance insufficient' })
  @ApiResponse({ status: 409, description: 'Request not in PENDING status' })
  async approve(@Param('id') id: string) {
    return this.requestService.approve(id);
  }

  @Patch(':id/reject')
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  @ApiOperation({ summary: 'Reject a request' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: RejectRequestDto })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Request not in PENDING status' })
  async reject(@Param('id') id: string, @Body() dto: RejectRequestDto) {
    return this.requestService.reject(id, dto.reason);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel a request (only PENDING or APPROVED)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409 })
  async cancel(@Param('id') id: string) {
    return this.requestService.cancel(id);
  }
}
