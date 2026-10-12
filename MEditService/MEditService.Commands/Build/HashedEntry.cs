using MEditService.RepositoriesLib;

namespace MEditService.Commands.Build;

internal sealed record HashedEntry(string Path, long Size, FileHash Hash);

/// <summary>An installation file as a whole and entry by entry, from one read.</summary>
internal sealed record HashedInstallationFile(long Size, FileHash Hash, IReadOnlyList<HashedEntry> Entries);

/// <summary>A file of a folder with the stamp that vouched for its hash.</summary>
internal sealed record HashedFile(string Path, long Size, FileStamp? Stamp, FileHash Hash);
