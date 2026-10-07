namespace MEditService.Index;

/// <summary>Which truth a plugin's rows were derived from (ADR-0007). A tracked plugin whose plugin
/// source is missing or cannot be read is derived from its binary (plugins.md, A row, Plugin).</summary>
public enum DerivedFrom
{
    Binary,
    SourceTree,
    BinaryForUnreadableSource,
}
