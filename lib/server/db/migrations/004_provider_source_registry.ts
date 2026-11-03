/**
 * Provenance and verification workflow for public provider directory imports.
 * Imported records remain unverified until a municipal administrator checks them.
 */
export const version = "004_provider_source_registry";

export const up = `
ALTER TABLE service_providers
  ADD COLUMN IF NOT EXISTS source_record_id text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_updated_at date,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'demo'
    CHECK (verification_status IN ('demo', 'imported_unverified', 'verified', 'rejected')),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by text,
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS location_source text;

ALTER TABLE service_providers
  ADD CONSTRAINT service_providers_latitude_range_v2
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT service_providers_longitude_range_v2
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

CREATE UNIQUE INDEX IF NOT EXISTS service_providers_source_record_idx
  ON service_providers(tenant_id, source_record_id)
  WHERE source_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS service_providers_verification_idx
  ON service_providers(tenant_id, verification_status, is_active);
`;

export const down = `
DROP INDEX IF EXISTS service_providers_verification_idx;
DROP INDEX IF EXISTS service_providers_source_record_idx;
ALTER TABLE service_providers
  DROP CONSTRAINT IF EXISTS service_providers_latitude_range_v2,
  DROP CONSTRAINT IF EXISTS service_providers_longitude_range_v2,
  DROP COLUMN IF EXISTS location_source,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS verified_by,
  DROP COLUMN IF EXISTS verified_at,
  DROP COLUMN IF EXISTS verification_status,
  DROP COLUMN IF EXISTS source_updated_at,
  DROP COLUMN IF EXISTS source_url,
  DROP COLUMN IF EXISTS source_record_id;
`;
