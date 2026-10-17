/**
 * Indian states and union territories (28 states + 8 union territories).
 *
 * Source: Government of India, National Portal of India — "States and Union Territories"
 * (https://knowindia.india.gov.in/states-uts/). Names of administrative divisions are public
 * facts; no third-party dataset or licence is involved. Codes below are this project's own
 * stable slugs, not ISO 3166-2 codes.
 *
 * This list only describes India's administrative divisions. It says NOTHING about where
 * VK Solar provides service — coverage is configured separately by an administrator.
 */
export interface Region {
  code: string;
  name: string;
  type: 'state' | 'ut';
}

const states: [string, string][] = [
  ['andhra-pradesh', 'Andhra Pradesh'],
  ['arunachal-pradesh', 'Arunachal Pradesh'],
  ['assam', 'Assam'],
  ['bihar', 'Bihar'],
  ['chhattisgarh', 'Chhattisgarh'],
  ['goa', 'Goa'],
  ['gujarat', 'Gujarat'],
  ['haryana', 'Haryana'],
  ['himachal-pradesh', 'Himachal Pradesh'],
  ['jharkhand', 'Jharkhand'],
  ['karnataka', 'Karnataka'],
  ['kerala', 'Kerala'],
  ['madhya-pradesh', 'Madhya Pradesh'],
  ['maharashtra', 'Maharashtra'],
  ['manipur', 'Manipur'],
  ['meghalaya', 'Meghalaya'],
  ['mizoram', 'Mizoram'],
  ['nagaland', 'Nagaland'],
  ['odisha', 'Odisha'],
  ['punjab', 'Punjab'],
  ['rajasthan', 'Rajasthan'],
  ['sikkim', 'Sikkim'],
  ['tamil-nadu', 'Tamil Nadu'],
  ['telangana', 'Telangana'],
  ['tripura', 'Tripura'],
  ['uttar-pradesh', 'Uttar Pradesh'],
  ['uttarakhand', 'Uttarakhand'],
  ['west-bengal', 'West Bengal'],
];

const unionTerritories: [string, string][] = [
  ['andaman-and-nicobar-islands', 'Andaman and Nicobar Islands'],
  ['chandigarh', 'Chandigarh'],
  ['dadra-and-nagar-haveli-and-daman-and-diu', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['delhi', 'Delhi'],
  ['jammu-and-kashmir', 'Jammu and Kashmir'],
  ['ladakh', 'Ladakh'],
  ['lakshadweep', 'Lakshadweep'],
  ['puducherry', 'Puducherry'],
];

export const REGIONS: Region[] = [
  ...states.map(([code, name]) => ({ code, name, type: 'state' as const })),
  ...unionTerritories.map(([code, name]) => ({ code, name, type: 'ut' as const })),
];
