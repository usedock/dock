import { IsIn, IsOptional } from 'class-validator';

export class StatsQuery {
  @IsOptional()
  @IsIn(['1h', '24h'])
  window?: '1h' | '24h';
}
