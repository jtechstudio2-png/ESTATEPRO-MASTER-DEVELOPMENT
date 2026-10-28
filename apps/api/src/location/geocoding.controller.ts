import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TenantDb } from '../database/database.module.js';
import { GEOCODER, type GeocoderPort, GeocoderUnavailableError } from './geocoder.js';
import { RateLimiter } from './rate-limiter.js';

export class GeocodeSuggestionDto {
  @ApiProperty() label!: string;
  @ApiProperty() latitude!: number;
  @ApiProperty() longitude!: number;
  @ApiProperty({ enum: ['rooftop', 'street', 'postcode', 'locality'] }) accuracy!: string;
  @ApiProperty({ enum: ['geocoder'], description: 'Send back as address.geocodeSource when the user accepts the suggestion' })
  geocodeSource!: 'geocoder';
}

export class GeocodeSuggestionListDto {
  @ApiProperty({ type: [GeocodeSuggestionDto] }) data!: GeocodeSuggestionDto[];
}

const COORDINATE_PAIR = /^-?\d{1,2}(\.\d{1,8})?,-?\d{1,3}(\.\d{1,8})?$/;

@ApiTags('Location')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class GeocodingController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly limiter: RateLimiter,
    @Inject(GEOCODER) private readonly geocoder: GeocoderPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Address suggestions (ADR-006 L-D2). Nothing is stored: the client shows the
   * suggestions, the user confirms or moves the pin, and the confirmed point is
   * sent with the property's address.
   */
  @Get('geocoding/suggestions')
  @RequirePermission('property.update')
  @ApiQuery({ name: 'q', required: true, description: 'Address text, 3–200 characters' })
  @ApiQuery({ name: 'countryCode', required: true, description: 'ISO 3166-1 alpha-2' })
  @ApiQuery({ name: 'near', required: false, description: 'latitude,longitude to rank nearby results first' })
  @ApiQuery({ name: 'language', required: false, description: 'Result language, e.g. en or ar' })
  @ApiOkResponse({ type: GeocodeSuggestionListDto })
  async suggest(
    @Tenant() ctx: TenantContext,
    @Query('q') q: unknown,
    @Query('countryCode') countryCode: unknown,
    @Query('near') near: unknown,
    @Query('language') language: unknown,
  ): Promise<GeocodeSuggestionListDto> {
    const errors: FieldError[] = [];
    const text = typeof q === 'string' ? q.trim() : '';
    if (text.length < 3 || text.length > 200) errors.push({ field: 'q', code: 'length', message: 'Search text must be 3 to 200 characters.' });
    if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode)) {
      errors.push({ field: 'countryCode', code: 'invalid', message: 'Use an ISO country code such as GH.' });
    }
    if (near !== undefined && (typeof near !== 'string' || !COORDINATE_PAIR.test(near))) {
      errors.push({ field: 'near', code: 'invalid-coordinates', message: 'Use latitude,longitude in decimal degrees.' });
    }
    if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2}$/.test(language))) {
      errors.push({ field: 'language', code: 'invalid', message: 'Use a two-letter language code such as en or ar.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    if (!this.geocoder.enabled) throw Problems.geocodingUnavailable();

    const country = await this.tenantDb.run(ctx, (tx) =>
      tx
        .selectFrom('countries')
        .select(['boundsSouth', 'boundsWest', 'boundsNorth', 'boundsEast'])
        .where('code', '=', countryCode as string)
        .where('isActive', '=', true)
        .executeTakeFirst(),
    );
    if (!country) throw Problems.validation([{ field: 'countryCode', code: 'unsupported', message: 'This country is not supported.' }]);

    this.limiter.take(`geocoding:${ctx.companyId}`, this.config.GEOCODER_RATE_LIMIT_PER_MINUTE);
    const [latitude, longitude] = typeof near === 'string' ? near.split(',').map(Number) : [];
    let suggestions;
    try {
      suggestions = await this.geocoder.suggest({
        text,
        countryCode: countryCode as string,
        proximity: latitude !== undefined && longitude !== undefined ? { latitude, longitude } : null,
        language: typeof language === 'string' ? language : null,
        limit: 5,
      });
    } catch (error) {
      if (error instanceof GeocoderUnavailableError) {
        throw Problems.geocodingUnavailable('Address suggestions are temporarily unavailable. Place the pin on the map or try again.');
      }
      throw error;
    }
    // L-D5: a suggestion outside the country could not be saved, so it is not offered.
    const inside = (s: { latitude: number; longitude: number }) =>
      country.boundsSouth === null ||
      (s.latitude >= Number(country.boundsSouth) &&
        s.latitude <= Number(country.boundsNorth) &&
        s.longitude >= Number(country.boundsWest) &&
        s.longitude <= Number(country.boundsEast));
    return { data: suggestions.filter(inside).map((s) => ({ ...s, geocodeSource: 'geocoder' as const })) };
  }
}
