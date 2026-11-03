import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "늘곁 지자체용 | Neulgyeot Municipality", template: "%s | 늘곁 지자체용" },
  description: "지역사회 통합돌봄 신청·조사·개인별 지원계획·서비스 연계·모니터링 업무 지원 시스템 (KREWX MVP)",
  applicationName: "Neulgyeot Municipality",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#13213c", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
