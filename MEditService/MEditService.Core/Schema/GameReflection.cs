namespace MEditService.Core.Schema;

/// <summary>What one game category's assembly resolved to, handed to every walk: the getter
/// type → table map every FormLink lookup needs, the game's annotations, and the codec's declared
/// defaults.</summary>
internal sealed record GameReflection(
    IReadOnlyDictionary<Type, string> GetterTypeToTable,
    SchemaAnnotations Annotations,
    DeclaredDefaults Defaults)
{
    // Read once the whole schema is built, by the annotations that claim something about the walk.
    internal WalkObservations Observed { get; } = new();
}
