export function isInside(folder: string, parent: string, platform: NodeJS.Platform): boolean {
  const [inner, outer, separator] = platform === 'win32'
    ? [folder.toLowerCase().replaceAll('/', '\\'), parent.toLowerCase().replaceAll('/', '\\'), '\\'] : [folder, parent, '/'];
  return inner === outer || inner.startsWith(outer.endsWith(separator) ? outer : outer + separator);
}
