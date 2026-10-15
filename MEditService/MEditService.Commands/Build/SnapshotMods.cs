namespace MEditService.Commands.Build;

/// <summary>The snapshot's mods, and the folder of the stat cache (mod-status trace).</summary>
public sealed record SnapshotMods(IReadOnlyList<ModByFolder> Mods, string StatCache);

/// <summary>A mod by its folder, with the files of it the repository commits, which no line names.</summary>
public sealed record ModByFolder(string Name, string Folder, IReadOnlyList<string> CommittedFiles);
