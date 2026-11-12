import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class CreateOrderDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) osId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) filialId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) clienteId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) mecanicoId?: string;
}
export class AssignDto { @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) mecanicoId!: string; }
export class DiagnosisDto { @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(4000) descricao!: string; }
export class ConsumeDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) pecaId!: string;
  @ApiProperty({minimum:1}) @IsInt() @Min(1) quantidade!: number;
  @ApiPropertyOptional({ format: 'uuid', description: 'Reuse the same UUID and payload when retrying a consumption whose response was lost.' })
  @IsOptional() @IsUUID() operationId?: string;
}
export class StockDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) filialId!: string;
  @ApiProperty({minimum:0,description:'Quantidade disponível, excluindo reservas existentes'}) @IsInt() @Min(0) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}
