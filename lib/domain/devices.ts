/**
 * Device capability profiles. A profile says what a device model can actually send, so that
 *  - consent categories outside the model's capabilities are refused at registration,
 *  - the control view does not expect real-time readings / location / fall / SOS from a device that cannot provide them
 *    (no false "갱신 지연" caution, no "SOS 대응" promise).
 * SIGRING100 is described from its public website (checked 2026-11-26). Nothing here is confirmed by the vendor;
 * see docs/SIGRING_INTEGRATION.md for the open questions.
 */
import type { DeviceKind, WearableMetric } from "./wearable";

export type DeviceProfile = {
  id: string;
  label: string;
  kind: DeviceKind;
  vendor: string;
  metrics: readonly WearableMetric[];
  /** metrics the vendor lists but whose availability as a value is not confirmed */
  unconfirmed: readonly WearableMetric[];
  realtimeReadings: boolean;
  location: boolean;
  /** how data reaches the gateway */
  sync: "gateway_realtime" | "phone_app_daily";
  medicalDevice: boolean;
  notes: readonly string[];
};

export const DEVICE_PROFILES = {
  generic_ring: {
    id: "generic_ring", label: "범용 스마트링 (DEMO 계약 v0.1)", kind: "smart_ring", vendor: "—",
    metrics: ["wear", "activity", "sleep", "heart_rate", "spo2", "temperature", "fall", "sos"], unconfirmed: [],
    realtimeReadings: true, location: true, sync: "gateway_realtime", medicalDevice: false, notes: [],
  },
  generic_watch: {
    id: "generic_watch", label: "범용 스마트워치 (DEMO 계약 v0.1)", kind: "smart_watch", vendor: "—",
    metrics: ["wear", "activity", "sleep", "heart_rate", "spo2", "temperature", "fall", "sos"], unconfirmed: [],
    realtimeReadings: true, location: true, sync: "gateway_realtime", medicalDevice: false, notes: [],
  },
  sigring100: {
    id: "sigring100", label: "시그링 SIGRING100 (연동 협의 전 · 공개 정보 기반)", kind: "smart_ring", vendor: "시그넘헬스",
    metrics: ["wear", "activity", "sleep", "heart_rate", "hrv", "skin_temp", "stress", "vitality", "spo2"], unconfirmed: ["spo2"],
    realtimeReadings: false, location: false, sync: "phone_app_daily", medicalDevice: false,
    notes: [
      "낙상 감지·SOS·GPS 기능이 없습니다. 긴급 호출이 필요한 대상자는 응급안전안심서비스 등 별도 장비를 함께 쓰세요.",
      "의료기기가 아니며, 피부 온도는 체온이 아니라 평소 대비 변화입니다.",
      "링 → 휴대폰 앱 → 제조사 서버 경로로 동기화되어 하루 단위로 도착할 수 있습니다(실시간 아님).",
      "공개 API가 없어 제조사(시그넘헬스)와 데이터 연계 협약이 필요합니다.",
    ],
  },
} as const satisfies Record<string, DeviceProfile>;
export type DeviceProfileId = keyof typeof DEVICE_PROFILES;
export const DEVICE_PROFILE_IDS = Object.keys(DEVICE_PROFILES) as DeviceProfileId[];
export const profileOf = (id: string | null | undefined): DeviceProfile => DEVICE_PROFILES[(id ?? "") as DeviceProfileId] ?? DEVICE_PROFILES.generic_ring;
export const defaultProfileFor = (kind: DeviceKind): DeviceProfileId => (kind === "smart_watch" ? "generic_watch" : "generic_ring");

/** Consent categories the device cannot produce (registration refuses them so consent matches reality). */
export const unsupportedMetrics = (profileId: string, metrics: readonly string[]) => metrics.filter((m) => !(profileOf(profileId).metrics as readonly string[]).includes(m));
