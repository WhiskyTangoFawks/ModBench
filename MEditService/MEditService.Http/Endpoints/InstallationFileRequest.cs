using MEditService.Commands.Build;

namespace MEditService.Http.Endpoints;

/// <summary>An installation file by its path, where the mod manager says it comes from, and its size, hash and
/// entries as the Instance adapter knows them (ADR-0013).</summary>
internal sealed record InstallationFileRequest(
    string Path, string? Source, long? Size, string Hash, IReadOnlyList<InstallationFileEntryRequest> Entries)
{
    internal bool IsWhole =>
        !string.IsNullOrWhiteSpace(Path) && Size is not null && !string.IsNullOrWhiteSpace(Hash) && Entries is not null
        && Entries.All(entry => !string.IsNullOrWhiteSpace(entry.Path) && !string.IsNullOrWhiteSpace(entry.Hash));

    internal InstallationFile ToInstallationFile() =>
        new(Path, Source, Size.GetValueOrDefault(), Hash, [.. Entries.Select(entry => new HashedEntry(entry.Path, entry.Hash))]);
}

/// <summary>An entry of an installation file by its forward-slash path inside it.</summary>
internal sealed record InstallationFileEntryRequest(string Path, string Hash);
