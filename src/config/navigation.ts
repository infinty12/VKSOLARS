export interface NavItem {
  label: string;
  href: string;
}

export const mainNav: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Services', href: '/services' },
  { label: 'AI Drone Inspection', href: '/ai-drone-inspection' },
  { label: 'About Us', href: '/about' },
  { label: 'Service Areas', href: '/service-areas' },
  { label: 'Contact', href: '/contact' },
];

/** Normalise a pathname so "/services/" and "/services" match. */
export function normalisePath(path: string) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

export function isActive(href: string, currentPath: string) {
  const current = normalisePath(currentPath);
  if (href === '/') return current === '/';
  return current === href || current.startsWith(`${href}/`);
}
