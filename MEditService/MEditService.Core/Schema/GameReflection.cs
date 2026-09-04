namespace MEditService.Core.Schema;

/// <summary>What one game category's assembly resolved to, handed to every walk: the getter
/// type → table map every FormLink lookup needs, and the game's <see cref="SchemaAnnotations"/>.</summary>
internal sealed record GameReflection(
    IReadOnlyDictionary<Type, string> GetterTypeToTable,
    SchemaAnnotations Annotations);
