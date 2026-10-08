namespace MEditService.Index;

/// <summary>Which truth a plugin's rows were derived from (ADR-0007). A tracked plugin whose plugin
/// source is missing or cannot be read is derived from its binary (plugins.md, A row, Plugin).</summary>
internal enum DerivedFrom
{
    Binary,
    SourceTree,
    BinaryForUnreadableSource,
}

internal static class DerivedFromReads
{
    /// <summary>Whether the plugin's mod was tracked when the Index read it.</summary>
    public static bool IsTracked(this DerivedFrom derivedFrom) =>
        derivedFrom is DerivedFrom.SourceTree or DerivedFrom.BinaryForUnreadableSource;
}
