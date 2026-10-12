namespace MEditService.Commands.Engine;

public sealed record HashedEntry(string Path, long Size, FileHash Hash);
