using System.Collections.Concurrent;

namespace MEditService.Codec.Schema;

/// <summary>What one game category's assembly resolved to, handed to every walk: the getter
/// type → table map every FormLink lookup needs, the game's annotations, the codec's declared
/// defaults, and which colours hold an alpha.</summary>
internal sealed record GameReflection(
    IReadOnlyDictionary<Type, string> GetterTypeToTable,
    SchemaAnnotations Annotations,
    DeclaredDefaults Defaults,
    HeldAlpha Alpha)
{
    // Read once the whole schema is built, by the annotations that claim something about the walk.
    internal WalkObservations Observed { get; } = new();

    internal int TableCount { get; } = GetterTypeToTable.Values.Distinct(StringComparer.OrdinalIgnoreCase).Count();

    // A plain enum in Mutagen, though its members are bits: the document spells it as its number.
    internal Type? TemplateFlagsEnum { get; } = GetterTypeToTable.Keys
        .FirstOrDefault(type => type.IsInterface && type.Name == Annotations.ActorTemplates.TypeName) is { } actor
        && ReflectedTypes.PropertyAt(actor, Annotations.ActorTemplates.FlagsMember) is { } flags
            ? ReflectedTypes.CoreOf(flags).Core
            : null;

    internal ConcurrentDictionary<Type, bool> ReachesATruncation { get; } = new();

    internal ConcurrentDictionary<Type, List<FieldMetadata>> PathFreeSubSchemas { get; } = new();
}
