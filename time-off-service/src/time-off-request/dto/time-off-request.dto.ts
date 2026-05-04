import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsDateString,
  IsOptional,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimeOffRequestDto {
  @ApiProperty({ example: 'emp-1' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ example: 'loc-1' })
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @ApiProperty({ example: '2027-06-01', description: 'YYYY-MM-DD' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2027-06-05', description: 'YYYY-MM-DD' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ example: 3, description: 'min 0.5 days' })
  @IsNumber()
  @IsPositive()
  @Min(0.5)
  days: number;

  @ApiPropertyOptional({ example: 'Family vacation' })
  @IsString()
  @IsOptional()
  reason?: string;
}

export class RejectRequestDto {
  @ApiProperty({ example: 'Not enough coverage that week' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
