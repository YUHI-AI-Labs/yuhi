export function parseRoster(path: string) {
  // TODO: handle empty rows (E1042)
  return readCsv(path);
}
