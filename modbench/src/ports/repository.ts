/** Makes one folder a repository. The host's git belongs to the host, so the composition root implements it. */
export type MakeRepository = (folder: string) => Promise<void>;
