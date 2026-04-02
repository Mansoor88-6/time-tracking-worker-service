import {
  IsInt,
  IsNumber,
  Min,
  IsString,
  IsIn,
  MinLength,
  MaxLength,
} from 'class-validator';

export class ManualOfflineEventDto {
  @IsInt()
  tenantId: number;

  @IsInt()
  userId: number;

  @IsInt()
  requestId: number;

  @IsNumber()
  @Min(0)
  startMs: number;

  @IsNumber()
  @Min(0)
  endMs: number;

  @IsIn(['productive', 'neutral', 'unproductive'])
  category: 'productive' | 'neutral' | 'unproductive';

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description: string;
}
