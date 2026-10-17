/**
 * ILLUSTRATIVE SAMPLE DATA for the AI Drone Inspection dashboard demonstration.
 *
 * These numbers are invented to show what an inspection report can contain.
 * They are NOT readings from any real plant and must always be displayed with the
 * "Illustrative sample data — not live telemetry" label. Replace this module with a
 * real data source (see README → "Drone dashboard integration") when one exists.
 */

export type Severity = 'Critical' | 'Moderate' | 'Minor';

export interface SampleFinding {
  id: string;
  type: string;
  location: string;
  deltaT: number; // °C above neighbouring cells
  severity: Severity;
  action: string;
}

export interface SampleBlock {
  id: string;
  label: string;
  capacityKw: number;
  modulesScanned: number;
  areaAcres: number;
  anomaliesByType: { type: string; count: number }[];
  /** Measured performance ratio per string, % of expected for conditions. */
  stringPerformance: { string: string; pct: number }[];
  findings: SampleFinding[];
}

export const sampleBlocks: SampleBlock[] = [
  {
    id: 'block-a',
    label: 'Block A',
    capacityKw: 500,
    modulesScanned: 920,
    areaAcres: 2.4,
    anomaliesByType: [
      { type: 'Soiling / shading', count: 14 },
      { type: 'Single-cell hotspot', count: 6 },
      { type: 'Cracked cells', count: 3 },
      { type: 'Bypass diode fault', count: 2 },
      { type: 'String offline', count: 0 },
    ],
    stringPerformance: [
      { string: 'A-01', pct: 98 },
      { string: 'A-02', pct: 97 },
      { string: 'A-03', pct: 91 },
      { string: 'A-04', pct: 99 },
      { string: 'A-05', pct: 86 },
      { string: 'A-06', pct: 96 },
    ],
    findings: [
      { id: 'A-05-12', type: 'Bypass diode fault', location: 'String A-05, module 12', deltaT: 14.2, severity: 'Critical', action: 'Replace junction box diode' },
      { id: 'A-03-07', type: 'Single-cell hotspot', location: 'String A-03, module 7', deltaT: 9.8, severity: 'Moderate', action: 'Clean and re-inspect' },
      { id: 'A-02-19', type: 'Cracked cells', location: 'String A-02, module 19', deltaT: 4.1, severity: 'Minor', action: 'Monitor at next visit' },
    ],
  },
  {
    id: 'block-b',
    label: 'Block B',
    capacityKw: 750,
    modulesScanned: 1380,
    areaAcres: 3.6,
    anomaliesByType: [
      { type: 'Soiling / shading', count: 22 },
      { type: 'Single-cell hotspot', count: 9 },
      { type: 'Cracked cells', count: 4 },
      { type: 'Bypass diode fault', count: 1 },
      { type: 'String offline', count: 1 },
    ],
    stringPerformance: [
      { string: 'B-01', pct: 95 },
      { string: 'B-02', pct: 0 },
      { string: 'B-03', pct: 93 },
      { string: 'B-04', pct: 88 },
      { string: 'B-05', pct: 97 },
      { string: 'B-06', pct: 94 },
    ],
    findings: [
      { id: 'B-02', type: 'String offline', location: 'String B-02 (all modules)', deltaT: 0, severity: 'Critical', action: 'Check fuse and DC isolator' },
      { id: 'B-04-03', type: 'Single-cell hotspot', location: 'String B-04, module 3', deltaT: 11.5, severity: 'Moderate', action: 'Inspect for debris or cell damage' },
      { id: 'B-06-21', type: 'Soiling / shading', location: 'String B-06, modules 18–24', deltaT: 3.2, severity: 'Minor', action: 'Include in next cleaning cycle' },
    ],
  },
  {
    id: 'block-c',
    label: 'Block C',
    capacityKw: 300,
    modulesScanned: 552,
    areaAcres: 1.5,
    anomaliesByType: [
      { type: 'Soiling / shading', count: 5 },
      { type: 'Single-cell hotspot', count: 2 },
      { type: 'Cracked cells', count: 1 },
      { type: 'Bypass diode fault', count: 0 },
      { type: 'String offline', count: 0 },
    ],
    stringPerformance: [
      { string: 'C-01', pct: 99 },
      { string: 'C-02', pct: 98 },
      { string: 'C-03', pct: 96 },
      { string: 'C-04', pct: 97 },
    ],
    findings: [
      { id: 'C-03-09', type: 'Single-cell hotspot', location: 'String C-03, module 9', deltaT: 7.4, severity: 'Moderate', action: 'Clean and re-inspect' },
      { id: 'C-01-02', type: 'Cracked cells', location: 'String C-01, module 2', deltaT: 3.6, severity: 'Minor', action: 'Monitor at next visit' },
    ],
  },
];

/** Strings below this share of expected output are flagged in the chart. */
export const PERFORMANCE_FLAG_PCT = 90;
