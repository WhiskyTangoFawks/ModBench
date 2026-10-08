namespace MEditService.SourceAdapter;

/// <summary>A file in plugin source, and whether it is the document of the record that carries the
/// record asked for rather than that record's own.</summary>
public sealed record DocumentFile(string Path, bool IsContainersDocument);
