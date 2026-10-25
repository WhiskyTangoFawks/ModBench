// The boxes are the Modbench column of spec/architecture/target-architecture.d2. A band's lib is a box
// the zoom-out does not draw; it counts where its folder is.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';

const MODBENCH = new URL('../', import.meta.url);
const SRC = new URL('src/', MODBENCH);
const ZOOM_OUT = new URL('../spec/architecture/target-architecture.d2', MODBENCH);

/** @returns {Record<string, string[]>} */
function drawnByBand() {
    /** @type {Record<string, string[]>} */
    const bands = {};
    /** @type {string[] | undefined} */
    let current;
    for (const line of readFileSync(ZOOM_OUT, 'utf8').split('\n')) {
        const container = /^modbench_(\w+): "/.exec(line)?.[1];
        if (container !== undefined) {
            current = [];
            bands[container] = current;
            continue;
        }
        if (/^\w/.test(line)) current = undefined;
        const member = /^ {2}(\w+): "/.exec(line)?.[1];
        if (member !== undefined && current !== undefined) current.push(member);
    }
    return bands;
}

const DRAWN = drawnByBand();

const PROJECT_FOLDERS = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'test' && existsSync(new URL(`${entry.name}/tsconfig.json`, SRC)))
    .map((entry) => entry.name);

/** @param {string} id */
const projectFolderOf = (id) => PROJECT_FOLDERS.find((folder) => folder.toLowerCase() === id);

/** @param {string} band @param {string} id @returns {string[]} */
function srcBoxOf(band, id) {
    const folder = projectFolderOf(id);
    if (folder !== undefined) return [folder];
    if (existsSync(new URL(`${id}/tsconfig.json`, MODBENCH))) return [];
    throw new Error(`target-architecture.d2 draws the box ${id} in modbench_${band}, and neither src/ nor modbench/ holds a project of that name`);
}

/** @param {string} band @returns {string[]} */
function boxesOf(band) {
    const drawn = DRAWN[band];
    if (drawn === undefined) throw new Error(`target-architecture.d2 draws no band modbench_${band}`);
    const lib = projectFolderOf(`${band}lib`);
    return [...(lib === undefined ? [] : [lib]), ...drawn.flatMap((id) => srcBoxOf(band, id))];
}

/** @type {Record<string, string[]>} */
export const BOXES_BY_BAND = Object.fromEntries(['kernel', 'driving', 'core', 'readmodel', 'repositories'].map((band) => [band, boxesOf(band)]));

export const DRIVING_BOXES = boxesOf('driving');
export const CORE_BOXES = boxesOf('core');
export const BOXES = Object.values(BOXES_BY_BAND).flat();
