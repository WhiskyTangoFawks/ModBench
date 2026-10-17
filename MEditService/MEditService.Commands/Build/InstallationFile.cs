namespace MEditService.Commands.Build;

/// <summary>An installation file by its path in the downloads folder, its page on its host, and its size, hash and
/// entries as the Instance adapter knows them (ADR-0013).</summary>
public sealed record InstallationFile(string Path, string? Page, long Size, string Hash, IReadOnlyList<HashedEntry> Entries);

/// <summary>An entry of an installation file by its forward-slash path inside it.</summary>
public sealed record HashedEntry(string Path, string Hash);
