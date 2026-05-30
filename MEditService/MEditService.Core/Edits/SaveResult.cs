namespace MEditService.Core.Edits;

public sealed record SaveResult(
    string BackupPath,
    IReadOnlyList<string> Applied,
    IReadOnlyList<string> ReadOnly,
    IReadOnlyList<string> NotFound);
