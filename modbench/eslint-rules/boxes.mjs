// The boxes are the Modbench column of spec/architecture/target-architecture.d2. A band's lib is a box
// the zoom-out does not draw; it counts where its folder is. A box in DRAWN_AHEAD_OF_CODE has no project yet;
// the entry goes when its project arrives.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';

const MODBENCH = new URL('../', import.meta.url);
const SRC = new URL('src/', MODBENCH);
const ZOOM_OUT = new URL('../spec/architecture/target-architecture.d2', MODBENCH);

export const DRAWN_AHEAD_OF_CODE = ['deployment'];

/** @param {string} drawing @returns {Record<string, string[]>} */
function drawnByBand(drawing) {
    /** @type {Record<string, string[]>} */
    const bands = {};
    /** @type {string[] | undefined} */
    let current;
    for (const line of drawing.split('\n')) {
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

const PROJECT_FOLDERS = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'test' && existsSync(new URL(`${entry.name}/tsconfig.json`, SRC)))
    .map((entry) => entry.name);

/** @param {string} id */
const projectFolderOf = (id) => PROJECT_FOLDERS.find((folder) => folder.toLowerCase() === id);

/** @param {string} band @param {string} id @returns {string[]} */
function srcBoxOf(band, id) {
    const folder = projectFolderOf(id);
    const ahead = DRAWN_AHEAD_OF_CODE.includes(id);
    if (ahead && (folder !== undefined || existsSync(new URL(`${id}/tsconfig.json`, MODBENCH)))) {
        throw new Error(`DRAWN_AHEAD_OF_CODE lists ${id}, and its project exists: remove the entry`);
    }
    if (ahead) return [];
    if (folder !== undefined) return [folder];
    if (existsSync(new URL(`${id}/tsconfig.json`, MODBENCH))) return [];
    throw new Error(`target-architecture.d2 draws the box ${id} in modbench_${band}, and neither src/ nor modbench/ holds a project of that name`);
}

/** @param {Record<string, string[]>} drawnBands @param {string} band @returns {string[]} */
function boxesOf(drawnBands, band) {
    const drawn = drawnBands[band];
    if (drawn === undefined) throw new Error(`target-architecture.d2 draws no band modbench_${band}`);
    const lib = projectFolderOf(`${band}lib`);
    return [...(lib === undefined ? [] : [lib]), ...drawn.flatMap((id) => srcBoxOf(band, id))];
}

/** @param {string} drawing @returns {Record<string, string[]>} */
export function boxesByBand(drawing) {
    const drawn = drawnByBand(drawing);
    return Object.fromEntries(['kernel', 'driving', 'core', 'readmodel', 'repositories'].map((band) => [band, boxesOf(drawn, band)]));
}

export const BOXES_BY_BAND = boxesByBand(readFileSync(ZOOM_OUT, 'utf8'));
export const DRIVING_BOXES = BOXES_BY_BAND.driving;
export const CORE_BOXES = BOXES_BY_BAND.core;
export const BOXES = Object.values(BOXES_BY_BAND).flat();
