// The Modbench column of the zoom-out, spec/architecture/target-architecture.d2, and each band's
// lib, which it does not draw, joined to the box folders on disk.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);
const ZOOM_OUT = new URL('../../spec/architecture/target-architecture.d2', import.meta.url);

/** @returns {Record<string, string[]>} */
function boxIdsByBand() {
    /** @type {Record<string, string[]>} */
    const bands = {};
    /** @type {string[] | undefined} */
    let current;
    for (const line of readFileSync(ZOOM_OUT, 'utf8').split('\n')) {
        const container = /^modbench_(\w+): "/.exec(line)?.[1];
        if (container !== undefined) {
            current = [`${container}lib`];
            bands[container] = current;
            continue;
        }
        if (/^\w/.test(line)) current = undefined;
        const member = /^ {2}(\w+): "/.exec(line)?.[1];
        if (member !== undefined && current !== undefined) current.push(member);
    }
    return bands;
}

const PROJECT_FOLDERS = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'test' && existsSync(new URL(`${entry.name}/tsconfig.json`, SRC)))
    .map((entry) => entry.name);

/** @param {string} id */
const folderOf = (id) => PROJECT_FOLDERS.find((folder) => folder.toLowerCase() === id);

/** @type {Record<string, string[]>} */
export const BOXES_BY_BAND = Object.fromEntries(
    Object.entries(boxIdsByBand()).map(([band, ids]) => [band, ids.flatMap((id) => folderOf(id) ?? [])]),
);

export const DRIVING_BOXES = BOXES_BY_BAND.driving ?? [];
export const CORE_BOXES = BOXES_BY_BAND.core ?? [];
export const BOXES = [
    ...(BOXES_BY_BAND.kernel ?? []), ...DRIVING_BOXES, ...CORE_BOXES,
    ...(BOXES_BY_BAND.readmodel ?? []), ...(BOXES_BY_BAND.repositories ?? []),
];
