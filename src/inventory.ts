import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'crypto';
import { Actor, admin, InternalGuard, JwtGuard } from './auth';
import { Conflict, Stock, Store } from './model';

export class CreatePieceDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) codigo!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) nome!: string;
  @ApiProperty() @IsNumber({maxDecimalPlaces:2}) @Min(0) @Max(1000000000) precoVenda!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) descricao?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) filialId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000000000) quantidadeInicial?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000000000) quantidadeMinima?: number;
}
export class UpdatePieceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(200) nome?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({maxDecimalPlaces:2}) @Min(0) @Max(1000000000) precoVenda?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) descricao?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000000000) quantidadeMinima?: number;
}
export class EntryDto { @ApiProperty() @IsInt() @Min(1) @Max(1000000000) quantidade!: number; }
export function legacyStock(stock: Stock) {
  return { filialId: stock.filialId, peca: { id: stock.pecaId, codigo: stock.codigo || stock.pecaId, nome: stock.nome || stock.description || stock.pecaId,
    descricao: stock.descricao ?? stock.description, precoVenda: stock.precoVenda || 0, ativo: stock.ativo !== false },
    quantidadeDisponivel: stock.quantity, quantidadeReservada: stock.reserved, quantidadeConsumida: stock.used, quantidadeMinima: stock.quantidadeMinima || 0 };
}
function searchText(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').trim();
}
const catalogOrder = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
@Injectable()
export class InventoryService {
  constructor(private readonly store: Store) {}
  async list(filialId?: string, page = '1', size = '20', busca = '', ativo?: string) {
    const pagina = Number(page), porPagina = Number(size);
    if (typeof page !== 'string' || typeof size !== 'string' || !Number.isInteger(pagina) || pagina < 1 || !Number.isInteger(porPagina) || porPagina < 1 || porPagina > 100) throw new BadRequestException('Invalid pagination');
    if (typeof busca !== 'string' || busca.length > 200 || (ativo !== undefined && !['true', 'false'].includes(ativo)) || (filialId !== undefined && (typeof filialId !== 'string' || filialId.length > 100))) throw new BadRequestException('Invalid inventory filters');
    const term = searchText(busca), active = ativo === undefined ? undefined : ativo === 'true';
    // Filter the complete catalog returned by the owner before slicing a page.
    // The final identity tie-breakers keep equal names stable across requests.
    const stock = (await this.store.listStock(filialId?.trim() || undefined))
      .filter(item => (active === undefined || (item.ativo !== false) === active)
        && (!term || [item.codigo || item.pecaId, item.nome, item.descricao, item.description].some(value => typeof value === 'string' && searchText(value).includes(term))))
      .sort((a, b) => catalogOrder.compare(a.nome || a.description || a.pecaId, b.nome || b.description || b.pecaId)
        || a.filialId.localeCompare(b.filialId) || (a.codigo || '').localeCompare(b.codigo || '') || a.pecaId.localeCompare(b.pecaId));
    return { data: stock.slice((pagina-1)*porPagina,pagina*porPagina).map(legacyStock), meta:{pagina,porPagina,total:stock.length,totalPaginas:Math.ceil(stock.length/porPagina)} };
  }
  async get(pecaId: string, filialId?: string): Promise<Stock> {
    const matches = filialId ? [await this.store.getStock(filialId,pecaId)].filter(Boolean) as Stock[] : (await this.store.listStock()).filter(stock=>stock.pecaId===pecaId);
    if (matches.length > 1) throw new ConflictException('Provide filialId for this piece');
    if (!matches.length) throw new NotFoundException('Piece not found');
    return matches[0];
  }
  async create(input: CreatePieceDto) {
    const stock: Stock = { ...input, pecaId:`pc${randomUUID()}`, filialId:input.filialId || 'filial-sp', quantity:input.quantidadeInicial || 0, reserved:0,used:0,ativo:true,quantidadeMinima:input.quantidadeMinima || 0 };
    try { await this.store.createCatalog(stock); } catch(error) { if (error instanceof Conflict) throw new ConflictException(error.message); throw error; }
    return legacyStock(stock);
  }
  async update(pecaId: string, patch: UpdatePieceDto & {ativo?:boolean}, filialId?: string) {
    const stock = await this.get(pecaId,filialId);
    const changes=Object.fromEntries(Object.entries(patch).filter(([,value])=>value!==undefined));
    if (!Object.keys(changes).length) throw new BadRequestException('Provide piece changes');
    return legacyStock(await this.store.updateCatalog(stock.filialId,pecaId,changes));
  }
  async entry(pecaId: string, quantity: number, filialId?: string) {
    const stock = await this.get(pecaId,filialId);
    return legacyStock(await this.store.addStock(stock.filialId,pecaId,quantity));
  }
}
function readInventory(actor: Actor) { if (!['ADMIN','ADMINISTRADOR','MECANICO'].includes(actor.role)) throw new ForbiddenException('Inventory access denied'); }
@ApiTags('Inventory') @ApiBearerAuth() @UseGuards(JwtGuard)
@Controller('api/v1/production/inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}
  @Get()
  @ApiQuery({ name: 'filialId', required: false })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'porPagina', required: false, type: Number })
  @ApiQuery({ name: 'busca', required: false, description: 'Trecho de código, nome ou descrição; ignora caixa e acentos, antes da paginação.' })
  @ApiQuery({ name: 'ativo', required: false, enum: ['true', 'false'], description: 'Ausente retorna ativos e inativos.' })
  list(@Req() req:{actor:Actor},@Query() query:Record<string,string>) { readInventory(req.actor); return this.service.list(query.filialId,query.pagina,query.porPagina,query.busca,query.ativo); }
  @Get(':id') async get(@Req() req:{actor:Actor},@Param('id') id:string,@Query('filialId') filial?:string) { readInventory(req.actor); return legacyStock(await this.service.get(id,filial)); }
  @Post() create(@Req() req:{actor:Actor},@Body() body:CreatePieceDto) { admin(req.actor); return this.service.create(body); }
  @Patch(':id') update(@Req() req:{actor:Actor},@Param('id') id:string,@Body() body:UpdatePieceDto,@Query('filialId') filial?:string) { admin(req.actor); return this.service.update(id,body,filial); }
  @Patch(':id/entrada') entry(@Req() req:{actor:Actor},@Param('id') id:string,@Body() body:EntryDto,@Query('filialId') filial?:string) { admin(req.actor); return this.service.entry(id,body.quantidade,filial); }
  @Patch(':id/ativar') activate(@Req() req:{actor:Actor},@Param('id') id:string,@Query('filialId') filial?:string) { admin(req.actor); return this.service.update(id,{ativo:true},filial); }
  @Patch(':id/desativar') deactivate(@Req() req:{actor:Actor},@Param('id') id:string,@Query('filialId') filial?:string) { admin(req.actor); return this.service.update(id,{ativo:false},filial); }
}

/** Service-to-service identity lookup; it does not grant inventory access to staff roles. */
@ApiTags('Internal') @ApiSecurity('internal-token') @UseGuards(InternalGuard)
@Controller('api/v1/production/internal/inventory')
export class InternalInventoryController {
  constructor(private readonly service: InventoryService) {}
  @Get(':id')
  @ApiQuery({ name: 'filialId', required: true })
  async get(@Param('id') id: string, @Query('filialId') filialId?: string) {
    if (typeof filialId !== 'string' || !filialId.trim() || filialId.length > 100) throw new BadRequestException('filialId is required');
    return legacyStock(await this.service.get(id, filialId));
  }
}
