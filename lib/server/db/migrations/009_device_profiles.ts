/**
 * Device capability profiles + ring-type daily metrics (contract 0.2). See docs/SIGRING_INTEGRATION.md.
 *  - wearable_devices.device_profile (generic_ring / generic_watch / sigring100)
 *  - wearable_daily_summaries: deep/REM sleep, HRV (RMSSD), skin-temperature deviation, stress index, vitality score
 *  - consent categories: hrv, skin_temp, stress, vitality
 *  - signal types: vitality_drop, hrv_drop, skin_temp_rise
 */
import { list } from "../../../domain/enums";
import { DEVICE_PROFILE_IDS } from "../../../domain/devices";
import { SIGNAL_TYPES_007 } from "./007_wearables";
import { METRICS_008 } from "./008_control";

export const version = "009_device_profiles";

export const METRICS_009 = [...METRICS_008, "hrv", "skin_temp", "stress", "vitality"] as const;
export const SIGNAL_TYPES_009 = [...SIGNAL_TYPES_007, "vitality_drop", "hrv_drop", "skin_temp_rise"] as const;

export const up = `
ALTER TABLE wearable_devices ADD COLUMN device_profile text NOT NULL DEFAULT 'generic_ring' CHECK (device_profile IN (${list(DEVICE_PROFILE_IDS)}));
UPDATE wearable_devices SET device_profile = 'generic_watch' WHERE device_kind = 'smart_watch';

ALTER TABLE wearable_daily_summaries
  ADD COLUMN sleep_deep_minutes integer CHECK (sleep_deep_minutes BETWEEN 0 AND 1440),
  ADD COLUMN sleep_rem_minutes integer CHECK (sleep_rem_minutes BETWEEN 0 AND 1440),
  ADD COLUMN hrv_rmssd integer CHECK (hrv_rmssd BETWEEN 1 AND 300),
  ADD COLUMN skin_temp_dev_c double precision CHECK (skin_temp_dev_c BETWEEN -5 AND 5),
  ADD COLUMN stress_index integer CHECK (stress_index BETWEEN 0 AND 100),
  ADD COLUMN vitality_score integer CHECK (vitality_score BETWEEN 0 AND 100);

ALTER TABLE wearable_consents DROP CONSTRAINT IF EXISTS wearable_consents_metrics_check;
ALTER TABLE wearable_consents ADD CONSTRAINT wearable_consents_metrics_check CHECK (metrics <@ ARRAY[${list(METRICS_009)}]::text[] AND 'wear' = ANY(metrics));
ALTER TABLE wearable_signals DROP CONSTRAINT IF EXISTS wearable_signals_signal_type_check;
ALTER TABLE wearable_signals ADD CONSTRAINT wearable_signals_signal_type_check CHECK (signal_type IN (${list(SIGNAL_TYPES_009)}));
`;

// Down (owner-run): the pre-009 CHECK cannot hold the new signal types and there is no equivalent old type,
// so those signal rows are deleted; the new columns and consent categories are dropped.
export const down = `
DELETE FROM wearable_signals WHERE signal_type IN ('vitality_drop', 'hrv_drop', 'skin_temp_rise');
ALTER TABLE wearable_signals DROP CONSTRAINT IF EXISTS wearable_signals_signal_type_check;
ALTER TABLE wearable_signals ADD CONSTRAINT wearable_signals_signal_type_check CHECK (signal_type IN (${list(SIGNAL_TYPES_007)}));
UPDATE wearable_consents SET metrics = array(SELECT m FROM unnest(metrics) m WHERE m <> ALL (ARRAY['hrv','skin_temp','stress','vitality'])) WHERE metrics && ARRAY['hrv','skin_temp','stress','vitality'];
ALTER TABLE wearable_consents DROP CONSTRAINT IF EXISTS wearable_consents_metrics_check;
ALTER TABLE wearable_consents ADD CONSTRAINT wearable_consents_metrics_check CHECK (metrics <@ ARRAY[${list(METRICS_008)}]::text[] AND 'wear' = ANY(metrics));
ALTER TABLE wearable_daily_summaries DROP COLUMN IF EXISTS vitality_score, DROP COLUMN IF EXISTS stress_index, DROP COLUMN IF EXISTS skin_temp_dev_c,
  DROP COLUMN IF EXISTS hrv_rmssd, DROP COLUMN IF EXISTS sleep_rem_minutes, DROP COLUMN IF EXISTS sleep_deep_minutes;
ALTER TABLE wearable_devices DROP COLUMN IF EXISTS device_profile;
`;
