namespace MEditService.Index;

/// <summary>Which truth a copy's rows were derived from (ADR-0007 invariant 3): its source tree,
/// which makes the copy tracked, or its binary.</summary>
internal enum DerivedFrom
{
    Binary,
    SourceTree,
}
