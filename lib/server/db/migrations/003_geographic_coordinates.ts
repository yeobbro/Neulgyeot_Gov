/**
 * Geographic reference metadata for administrative areas.
 * Coordinates describe approximate area centers only; they are not household,
 * provider or official administrative-boundary geometries.
 */
export const version = "003_geographic_coordinates";

export const up = `
ALTER TABLE region_units
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS location_source text,
  ADD COLUMN IF NOT EXISTS location_precision text;

ALTER TABLE service_providers
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS location_source text,
  ADD COLUMN IF NOT EXISTS location_precision text;

ALTER TABLE region_units
  ADD CONSTRAINT region_units_latitude_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT region_units_longitude_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

ALTER TABLE service_providers
  ADD CONSTRAINT service_providers_latitude_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT service_providers_longitude_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
`;

export const down = `
ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS service_providers_latitude_range;
ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS service_providers_longitude_range;
ALTER TABLE region_units DROP CONSTRAINT IF EXISTS region_units_latitude_range;
ALTER TABLE region_units DROP CONSTRAINT IF EXISTS region_units_longitude_range;

ALTER TABLE service_providers
  DROP COLUMN IF EXISTS location_precision,
  DROP COLUMN IF EXISTS location_source,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS latitude;

ALTER TABLE region_units
  DROP COLUMN IF EXISTS location_precision,
  DROP COLUMN IF EXISTS location_source,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS latitude;
`;
