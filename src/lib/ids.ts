let counter = 0;

/** Build-time unique id suffix for SVG defs that may render more than once per page. */
export function nextId() {
  counter += 1;
  return counter.toString(36);
}
