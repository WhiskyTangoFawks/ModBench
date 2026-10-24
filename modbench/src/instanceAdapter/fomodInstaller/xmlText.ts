// The text of an XML element as a reader takes it: a CDATA section as it stands, and the five entities unescaped.

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

export const xmlText = (value: string): string =>
  value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(amp|lt|gt|quot|apos);/g, (entity, cdata: string | undefined, name: string | undefined) =>
    cdata ?? ENTITIES[name ?? ''] ?? entity);
