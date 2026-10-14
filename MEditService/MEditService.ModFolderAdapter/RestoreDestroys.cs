namespace MEditService.ModFolderAdapter;

/// <summary>What restore from manifest would destroy in a mod folder, by forward-slash path: each file the stat cache
/// cannot vouch holds the bytes its provider fixes, and each file no line names.</summary>
public sealed record RestoreDestroys(IReadOnlyList<string> Differing, IReadOnlyList<string> NamedByNoLine);
