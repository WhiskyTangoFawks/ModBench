import { INSTANCE_REPOSITORY_GUIDE } from './guides/instanceRepository';
import { MO2_INSTANCE_GUIDE } from './guides/instance/mo2';
import { NEXUS_GUIDE } from './guides/nexus';
import { RECORDS_GUIDE } from './guides/records';
import { SCRIPTING_AND_QUERIES_GUIDE } from './guides/scriptingAndQueries';
import { SOURCE_MODS_GUIDE } from './guides/sourceMods';
import { SYMBOLS_GUIDE } from './guides/symbols';

// spec/GLOSSARY.md's text, which esbuild.mjs and vitest.config.ts define.
declare const GLOSSARY: string;

const withoutOpeningLine = (text: string): string => text.slice(text.indexOf('\n') + 1).trimStart();

export const GUIDES = {
  vocabulary: withoutOpeningLine(GLOSSARY),
  records: RECORDS_GUIDE,
  'source-mods': SOURCE_MODS_GUIDE,
  'instance-repository': INSTANCE_REPOSITORY_GUIDE,
  nexus: NEXUS_GUIDE,
  'scripting-and-queries': SCRIPTING_AND_QUERIES_GUIDE,
  symbols: SYMBOLS_GUIDE,
} as const;

export const INSTANCE_GUIDE_BY_MANAGER: Readonly<Record<string, string>> = {
  MO2: MO2_INSTANCE_GUIDE,
};
