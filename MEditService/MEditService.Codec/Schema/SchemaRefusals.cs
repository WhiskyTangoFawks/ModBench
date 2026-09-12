using System.Reflection;
using Microsoft.Extensions.Logging;

namespace MEditService.Codec.Schema;

/// <summary>Everything the reflected schema declines and the reason it gives: named read-only
/// reasons, shapes real data reaches with no decided presentation, and the anomaly channel for a
/// property in no structural class. Silence is never an outcome.</summary>
internal static class SchemaRefusals
{
    // Every property lands in one structural class or says so here, through the ILogger. Warning, not
    // Debug: an unclassified property is a field the editor can neither see nor write, and should be
    // loud in a real run.
    internal const string UnclassifiedAnomalyPrefix = "SchemaReflector: unclassified";

    /// <summary>The header's author/flags: a write reaching them is refused here, not at a gate.</summary>
    internal const string HeaderNoWritePathReason = "the header has no write path for this column";

    private static string TypeLabel(Type type) =>
        type.IsGenericType
            ? $"{type.Name[..type.Name.IndexOf('`', StringComparison.Ordinal)]}" +
              $"<{string.Join(", ", type.GetGenericArguments().Select(TypeLabel))}>"
            : type.Name;

    internal static T? ReportUnclassified<T>(GameReflection game, ILogger logger, PropertyInfo prop, Type shape, string site)
        where T : class
    {
        var owner = prop.DeclaringType?.Name ?? "?";
        if ((ExcludedShapeReason(game, shape) ?? EmptySubSchemaReason(game, shape)) is { } reason)
        {
            // Named, so not an anomaly — but still said out loud, at Debug, so a real run can answer
            // "why is this field missing?" without anyone reading this file. Guarded because
            // TypeLabel builds a string for a generic shape (CA1873).
            if (logger.IsEnabled(LogLevel.Debug))
            {
                logger.LogDebug("SchemaReflector: excluded {Owner}.{Property} :: {Shape} — {Reason}",
                    owner, prop.Name, TypeLabel(shape), reason);
            }
            return null;
        }

        logger.LogWarning(
            UnclassifiedAnomalyPrefix + " {Owner}.{Property} :: {Shape} [{Site}]",
            owner, prop.Name, TypeLabel(shape), site);
        return null;
    }

    // A shape the walk reaches and could present, but nobody has decided a presentation for. A byte
    // slice is a hex leaf ByteSliceHex classifies long before this is asked.
    private static string? ExcludedShapeReason(GameReflection game, Type shape) =>
        ByteSliceHex.IsByteSlice(shape) ? null : game.Annotations.RefusedShapeReason(shape);

    // A Loqui struct whose own sub-schema comes out empty, so there is nothing to present. Recorded
    // as observed, since the annotation claiming it is validated against what the walk found.
    private static string? EmptySubSchemaReason(GameReflection game, Type shape)
    {
        if (!game.Annotations.IsEmptySubSchemaType(shape)) return null;
        game.Observed.CameOutEmpty(shape.Name);
        return "empty sub-schema — the shape declares no member the walk can present";
    }

    internal static bool IsExcludedUnionColumn(PropertyInfo prop, GameReflection game)
    {
        var core = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
        return ReflectedTypes.IsLoquiInterface(core)
            && ReflectedTypes.GetSetterType(core) is { } setterType
            && game.Annotations.IsExcludedUnion(setterType);
    }
}
