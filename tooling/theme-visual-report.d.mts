export interface MeasurementReport {
  schemaVersion: 1;
  status: string;
  kind: 'geometry-and-typography';
  thresholds: { geometry: number; fontSize: number; lineHeight: number };
  checks: Array<{ slot: string; property: string; pass: boolean; difference?: number; expected?: number; actual?: number; tolerance?: number; reason?: string }>;
  missing: string[];
  visualComparison: 'not-established';
  manualReviewRequired: true;
}
export function compareThemeMeasurements(reference: unknown, replay: unknown, thresholds?: { geometry: number; fontSize: number; lineHeight: number }): MeasurementReport;
