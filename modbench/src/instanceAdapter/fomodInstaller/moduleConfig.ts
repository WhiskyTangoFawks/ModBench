// The module config the engine reads: the release's own, changed only where the engine reads it otherwise than the
// reference installer does.

const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const SCHEMA = 'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd"';

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

const unescaped = (value: string): string => value.replace(/&(amp|lt|gt|quot|apos);/g, (entity, name: string) => ENTITIES[name] ?? entity);

// The engine takes a config's version from the schema it names, and cannot read one that names none.
const withSchemaNamed = (text: string): string =>
  text.replace(/<config\b([^>]*)>/, (root, attributes: string) => {
    if (/\bnoNamespaceSchemaLocation\s*=/.test(attributes)) return root;
    return `<config ${/\bxmlns:xsi\s*=/.test(attributes) ? '' : `${XSI} `}${SCHEMA}${attributes}>`;
  });

// The engine names a file source its archive lacks and passes over a folder source in silence, so a missing folder
// goes to it as a file.
const withMissingFoldersAsFiles = (text: string, holds: (folder: string) => boolean): string =>
  text.replace(/<folder\b([^>]*?)\/?>(\s*<\/folder>)?/g, (element, attributes: string) => {
    const source = /\bsource\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes);
    const named = source?.[1] ?? source?.[2];
    return named === undefined || holds(unescaped(named)) ? element : `<file${attributes}/>`;
  });

/** The release's module config as the engine is to read it, `holds` saying whether the release holds a folder. */
export const moduleConfigForEngine = (text: string, holds: (folder: string) => boolean): string =>
  withMissingFoldersAsFiles(withSchemaNamed(text), holds);
