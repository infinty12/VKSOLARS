import type { IconName } from '../components/icons';

export interface Service {
  slug: string;
  title: string;
  icon: IconName;
  /** One-line summary for cards. */
  summary: string;
  /** Paragraph for the services page. */
  description: string;
  /** What the visit typically covers. */
  includes: string[];
  benefits: string[];
  /** Short tag for the comparison table. */
  category: 'Solar care' | 'Diagnostics' | 'Monitoring' | 'Facility';
  bestFor: string;
}

export const services: Service[] = [
  {
    slug: 'solar-panel-cleaning',
    title: 'Solar Panel Cleaning',
    icon: 'droplets',
    summary: 'Safe removal of dust, bird droppings and residue that block sunlight from reaching your cells.',
    description:
      'Rajasthan’s dry, dusty conditions cause soiling to build up quickly on module glass. Our cleaning service removes dust and residue using methods suited to solar glass and coatings, so more light reaches the cells.',
    includes: [
      'Pre-clean visual check of modules and mounting',
      'Cleaning with methods suited to module glass and anti-reflective coatings',
      'Attention to frame edges where dust and debris collect',
      'Post-clean walkthrough and photo record',
    ],
    benefits: ['Recovers output lost to soiling', 'Reduces risk of hotspots from persistent debris', 'Visual condition record of every visit'],
    category: 'Solar care',
    bestFor: 'Rooftop and ground-mount plants in dusty environments',
  },
  {
    slug: 'preventive-maintenance',
    title: 'Preventive Maintenance',
    icon: 'wrench',
    summary: 'Scheduled checks of modules, wiring, inverters and structures to catch problems before they cost you.',
    description:
      'Preventive maintenance is a planned programme of inspections and minor corrective work across your plant, designed to find wear and loose connections before they become outages.',
    includes: [
      'Module, junction box and connector inspection',
      'DC/AC cabling and termination checks',
      'Inverter visual and status review',
      'Mounting structure, earthing and fastener checks',
      'Maintenance log with findings and recommended actions',
    ],
    benefits: ['Fewer unplanned breakdowns', 'Longer equipment life', 'Documented maintenance history'],
    category: 'Solar care',
    bestFor: 'Plants that need a planned annual maintenance schedule',
  },
  {
    slug: 'ai-drone-inspection',
    title: 'AI Drone Solar Inspection',
    icon: 'drone',
    summary: 'Aerial thermal and visual surveys that map faults across large arrays quickly.',
    description:
      'Drone-mounted thermal and visual cameras survey large arrays far faster than walking every row. Software-assisted analysis helps flag thermal anomalies such as hotspots and underperforming strings for follow-up.',
    includes: [
      'Flight planning for the site layout',
      'Thermal (infrared) and visual imaging',
      'Software-assisted anomaly detection and classification',
      'Report with located findings and recommended actions',
    ],
    benefits: ['Covers large sites quickly', 'Locates problems to specific modules', 'Minimal disruption to operations'],
    category: 'Diagnostics',
    bestFor: 'Large rooftops and utility or ground-mount plants',
  },
  {
    slug: 'performance-testing',
    title: 'Performance Testing',
    icon: 'gauge',
    summary: 'Electrical testing that shows how your system is really performing against what it should deliver.',
    description:
      'Performance testing measures the electrical behaviour of your strings and inverters so you can see whether the plant is delivering what it should, and where losses are coming from.',
    includes: [
      'String-level electrical measurements',
      'Comparison against expected performance for conditions',
      'Inverter output review',
      'Summary of measured losses and likely causes',
    ],
    benefits: ['Quantifies underperformance', 'Prioritises the repairs that matter most', 'Baseline for future comparisons'],
    category: 'Diagnostics',
    bestFor: 'Plants with unexplained drops in generation',
  },
  {
    slug: 'solar-fault-detection',
    title: 'Solar Fault Detection',
    icon: 'alert',
    summary: 'Systematic troubleshooting to find and isolate faults in modules, strings and connections.',
    description:
      'When generation drops or an inverter reports errors, our fault detection service traces the problem through modules, strings, connectors and protection devices to isolate the cause.',
    includes: [
      'Review of inverter alarms and generation history',
      'Targeted electrical and thermal checks',
      'Isolation of faulty modules, strings or connectors',
      'Clear findings with recommended corrective work',
    ],
    benefits: ['Faster return to full output', 'Avoids replacing healthy equipment', 'Reduces safety risk from electrical faults'],
    category: 'Diagnostics',
    bestFor: 'Plants with alarms, tripping or sudden output loss',
  },
  {
    slug: 'solar-health-monitoring',
    title: 'Solar Health Monitoring',
    icon: 'activity',
    summary: 'Ongoing review of plant data and periodic reporting so issues are spotted early.',
    description:
      'Health monitoring combines periodic reviews of your plant’s generation data with on-site checks, giving you a clear, regular picture of system condition and trends.',
    includes: [
      'Periodic review of generation and inverter data',
      'Trend tracking against previous periods',
      'Early flagging of unusual drops',
      'Regular health reports',
    ],
    benefits: ['Problems spotted earlier', 'Clear trend history', 'Better maintenance planning'],
    category: 'Monitoring',
    bestFor: 'Owners who want regular visibility of plant condition',
  },
  {
    slug: 'ac-service',
    title: 'AC Service',
    icon: 'snowflake',
    summary: 'Air-conditioner servicing for commercial and industrial premises.',
    description:
      'Alongside solar care, we service air-conditioning units at commercial and industrial premises — cleaning, checking and keeping systems running efficiently through Rajasthan’s summers.',
    includes: [
      'Filter and coil cleaning',
      'Drainage check',
      'Operational and cooling performance check',
      'Service notes and recommended repairs',
    ],
    benefits: ['Better cooling efficiency', 'Lower risk of summer breakdowns', 'One provider for site services'],
    category: 'Facility',
    bestFor: 'Offices, factories and commercial buildings',
  },
  {
    slug: 'rooftop-water-tank-cleaning',
    title: 'Rooftop Water Tank Cleaning',
    icon: 'tank',
    summary: 'Cleaning of rooftop water storage tanks to remove sediment and build-up.',
    description:
      'Rooftop tanks collect sediment, algae and debris over time. We drain, clean and rinse tanks so stored water stays cleaner, often alongside rooftop solar visits.',
    includes: ['Draining and sludge removal', 'Scrubbing of internal surfaces', 'Rinse and refill', 'Lid and fitting check'],
    benefits: ['Cleaner stored water', 'Removes sediment and algae build-up', 'Convenient to combine with rooftop solar visits'],
    category: 'Facility',
    bestFor: 'Commercial, industrial and residential rooftops',
  },
];

export const serviceBySlug = (slug: string) => services.find((s) => s.slug === slug);

/** Link to a service's section on the Services page. */
export const serviceHref = (slug: string) =>
  slug === 'ai-drone-inspection' ? '/ai-drone-inspection' : `/services#${slug}`;

/** Link to the contact form with the service pre-selected. */
export const serviceEnquiryHref = (slug: string) => `/contact?service=${encodeURIComponent(slug)}#enquiry`;
