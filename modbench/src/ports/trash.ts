/** Moves one file to the system trash. The trash belongs to the host, so the composition root
 *  implements it and every command that trashes is handed it. */
export type MoveToTrash = (path: string) => Promise<void>;
