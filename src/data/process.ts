import type { IconName } from '../components/icons';

export interface ProcessStep {
  title: string;
  description: string;
  icon: IconName;
}

export const processSteps: ProcessStep[] = [
  {
    title: 'Inspection & Assessment',
    description: 'We survey your site, review generation history and identify soiling, damage and likely losses.',
    icon: 'search',
  },
  {
    title: 'Cleaning & Maintenance',
    description: 'Panels are cleaned and preventive maintenance is carried out on modules, wiring and structures.',
    icon: 'droplets',
  },
  {
    title: 'Performance Testing',
    description: 'Electrical and thermal checks confirm how each part of the system is performing.',
    icon: 'gauge',
  },
  {
    title: 'Monitoring & Reporting',
    description: 'You receive a clear report of findings, actions taken and recommendations.',
    icon: 'report',
  },
  {
    title: 'Improved Solar Efficiency',
    description: 'With losses addressed, your plant is positioned to deliver closer to its potential.',
    icon: 'trending',
  },
];

export const benefits: { title: string; description: string; icon: IconName }[] = [
  {
    title: 'Planned maintenance',
    description: 'Scheduled care that catches wear and loose connections before they turn into downtime.',
    icon: 'wrench',
  },
  {
    title: 'Higher efficiency',
    description: 'Clean modules and resolved faults help your plant convert more sunlight into power.',
    icon: 'sun',
  },
  {
    title: 'Longer asset life',
    description: 'Regular inspection and upkeep help protect the long-term value of your solar investment.',
    icon: 'shield',
  },
  {
    title: 'Trained technicians',
    description: 'Work carried out by personnel trained to work safely around solar and electrical equipment.',
    icon: 'users',
  },
  {
    title: 'Inspection technology',
    description: 'Drone thermal imaging and electrical testing locate problems precisely, not by guesswork.',
    icon: 'drone',
  },
  {
    title: 'Clear reporting',
    description: 'Every visit ends with documented findings, so you always know the condition of your plant.',
    icon: 'report',
  },
];
