namespace MEditService.SourceAdapter;

// A relative path read as the layout's own segments: the one place a segment index means anything.
// plugin-source / <plugin> / <group folder> / [block levels] / <record directory> / RecordData.json.
internal sealed class LayoutPath(string relativePath)
{
    private const int RootSegment = 0;
    private const int PluginSegment = 1;
    private const int GroupFolderSegment = 2;
    private const int HeaderDocumentDepth = 3;
    private const int FlatDocumentDepth = 4;
    private const int ShallowestContainerDocument = 5;

    private readonly string[] _segments =
        relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);

    internal string PluginFileName => _segments[PluginSegment];

    internal string GroupFolderName => _segments[GroupFolderSegment];

    private string Leaf => _segments[^1];

    private bool UnderTheSourceRoot =>
        _segments.Length > RootSegment && _segments[RootSegment].Equals(SourceRepositoryLayout.RootFolderName, StringComparison.Ordinal);

    private bool NamesAPlugin => _segments.Length > PluginSegment && _segments[PluginSegment].Length > 0;

    internal bool IsHeaderDocument =>
        _segments.Length == HeaderDocumentDepth && UnderTheSourceRoot && NamesAPlugin
        && Leaf.Equals(SourceRepositoryLayout.RecordDataFileName, StringComparison.Ordinal);

    internal bool IsFlatDocument =>
        _segments.Length >= FlatDocumentDepth && UnderTheSourceRoot && NamesAPlugin
        && Leaf.EndsWith(SourceRepositoryLayout.JsonSuffix, StringComparison.Ordinal)
        && !Leaf.Equals(SourceRepositoryLayout.RecordDataFileName, StringComparison.Ordinal)
        && !Leaf.Equals(SourceRepositoryLayout.GroupRecordDataFileName, StringComparison.Ordinal);

    // A container's own field file, at its group's own level or deeper.
    internal bool IsContainerDocument =>
        _segments.Length >= ShallowestContainerDocument
        && Leaf.Equals(SourceRepositoryLayout.RecordDataFileName, StringComparison.Ordinal);

    // Below its group's own directory level: an interior cell in a block, an exterior cell in its
    // worldspace's blocks.
    internal bool ContainerIsNested => _segments.Length > ShallowestContainerDocument;

    // A block and a sub-block level sit between a cell's own directory and whatever holds it: its
    // group folder for an interior cell, its worldspace's own directory for an exterior one.
    private const int BlockLevels = 2;

    internal bool UnderGroupBlockLevels =>
        IsContainerDocument && _segments.Length == ShallowestContainerDocument + BlockLevels;

    internal bool UnderWorldspaceBlockLevels =>
        IsContainerDocument && _segments.Length == ShallowestContainerDocument + BlockLevels + 1;

    internal string BlockFolderName => _segments[^4];

    internal string SubBlockFolderName => _segments[^3];

    /// <summary>The worldspace's own directory, for a path <see cref="UnderWorldspaceBlockLevels"/>
    /// answers for: everything above the two block levels and the cell's own directory.</summary>
    internal string WorldspaceDirectory =>
        Path.Combine(_segments[..(ShallowestContainerDocument - 1)]);
}
