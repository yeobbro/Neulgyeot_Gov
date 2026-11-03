"use client";
import { api } from "./api";
export function PrintButton({ type, rows }: { type: "report" | "case_summary" | "meeting_brief"; rows: number }) {
  return <button type="button" className="btn no-print" onClick={async () => { await api("/api/exports/print", { body: { type, rows, personal: false } }); window.print(); }}>인쇄·PDF 저장</button>;
}
