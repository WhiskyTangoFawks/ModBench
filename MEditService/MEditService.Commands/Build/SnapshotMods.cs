namespace MEditService.Commands.Build;

/// <summary>The snapshot's mods, and the folder of the stat cache (mod-status trace).</summary>
public sealed record SnapshotMods(IReadOnlyList<ModByFolder> Mods, string StatCache);

/// <summary>A mod by its folder, with the files of it the repository commits, which no line names, and the metadata the mod
/// manager holds of it when the request asks about it.</summary>
public sealed record ModByFolder(string Name, string Folder, IReadOnlyList<string> CommittedFiles, ModMetadata? Metadata = null);
