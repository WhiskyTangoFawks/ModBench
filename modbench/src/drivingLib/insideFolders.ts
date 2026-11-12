const slashed = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

/** Whether `path` is one of `folders` or below one. */
export const isInsideAny = (folders: readonly string[], path: string): boolean => {
  const held = slashed(path);
  return folders.some((folder) => held === slashed(folder) || held.startsWith(`${slashed(folder)}/`));
};
