namespace MEditService.Commands.Build;

/// <summary>The snapshot's mods, and the folder of the stat cache (mod-status trace).</summary>
public sealed record SnapshotMods(IReadOnlyList<SnapshotMod> Mods, string StatCache);

/// <summary>A mod of the snapshot, with the files of its folder the repository commits, which no line names.</summary>
public sealed record SnapshotMod(string Name, string Folder, IReadOnlyList<string> CommittedFiles);
