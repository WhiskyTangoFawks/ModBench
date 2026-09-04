using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>Everything the reflected schema declines and the reason it gives: named read-only
/// reasons, shapes real data reaches with no decided presentation, and the anomaly channel for a
/// property in no structural class. Silence is never an outcome.</summary>
internal static class SchemaRefusals
{
    // Every property lands in one structural class or says so here, through the ILogger. Warning, not
    // Debug: an unclassified property is a field the editor can neither see nor write, and should be
    // loud in a real run.
    internal const string UnclassifiedAnomalyPrefix = "SchemaReflector: unclassified";

    /// <summary>A discriminator is consumed off the raw JSON to choose a concrete type, before the
    /// object it would apply to exists, so naming it stays a silent skip.</summary>
    internal const string DiscriminatorReason =
        "discriminator: read off the payload to choose a concrete type, before that object exists";

    /// <summary>An element-shape template carried by a list's metadata. A list is written as one whole
    /// value through its owning field, so the template itself is never a write target.</summary>
    internal const string ElementTemplateReason =
        "list element template: a list is written as one whole value through its owning field";

    /// <summary>A list whose element type classifies for reading but has no build arm: a translated
    /// string, or an integer width <see cref="LeafClassification.PrimitiveMap"/> lacks. No Fallout 4
    /// leaf is either; this keeps the classification total.</summary>
    internal const string UnconvertibleElementListReason =
        "list element: the element type has no JSON converter, so no element can be built from a payload";

    /// <summary>Not reachable for any shape ClassifyLeaf returns today — every one has a converter or
    /// is a form link or byte slice — so this names a branch that exists to keep the choice total.</summary>
    internal const string NoConverterReason =
        "leaf with no JSON converter and no form-link write path";

    /// <summary>The header's author/flags: a write reaching them is refused here, not at a gate.</summary>
    internal const string HeaderNoWritePathReason =
        "the header's write path was built and deliberately deleted (#633); no write exists for this column";

    private static string TypeLabel(Type type) =>
        type.IsGenericType
            ? $"{type.Name[..type.Name.IndexOf('`', StringComparison.Ordinal)]}" +
              $"<{string.Join(", ", type.GetGenericArguments().Select(TypeLabel))}>"
            : type.Name;

    internal static T? ReportUnclassified<T>(GameReflection game, ILogger logger, PropertyInfo prop, Type shape, string site)
        where T : class
    {
        var owner = prop.DeclaringType?.Name ?? "?";
        if ((ExcludedShapeReason(shape) ?? EmptySubSchemaReason(game, shape)) is { } reason)
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

    // A shape the walk reaches and could present, but nobody has decided a presentation for, is named
    // here. Counts are live, from the audit's enumeration over Fallout 4. Each reason says what a
    // future ticket would have to decide.
    internal static string? ExcludedShapeReason(Type shape)
    {
        var open = shape.IsGenericType ? shape.GetGenericTypeDefinition() : null;

        // Real modding content: Race height, head data, models and voices per sex, ArmorAddon models,
        // faction rank titles. Deferred: presenting a gendered pair is a new rendered shape needing
        // its own xEdit-shape decision, a maintainer call.
        if (open == typeof(IGenderedItemGetter<>))
            return "gendered Male/Female pair — 20 fields; real data, deferred pending a presentation decision";

        // A slice of typed elements is a list shape; only a byte slice has a hex reading, and the
        // element-type test keeps a byte slice reaching an untaught site loud.
        if (open == typeof(ReadOnlyMemorySlice<>) && !ByteSliceHex.IsByteSlice(shape))
            return "non-byte element slice — 2 fields; an array of typed elements, not a hex blob";

        // 4 fields: LandscapeVertexHeightMap-style grids. Real data, tiny population, no grid shape.
        if (open == typeof(IReadOnlyArray2d<>))
            return "2D array grid — 4 fields; no grid presentation exists";

        // 2 fields: Race.BipedObjects (keyed by BipedObject) and Package.Data (keyed by SByte). Real
        // data; a keyed map is a shape neither the schema's array nor its struct model covers.
        if (open == typeof(IReadOnlyDictionary<,>))
            return "keyed map — 2 fields; neither the array nor the struct model covers a dictionary";

        // Candidate atomic-value entries, each a new rendered leaf needing its own xEdit-shape decision:
        // Percent is a raw float in xEdit, TimeOnly a byte in 10-minute increments, RecordType a
        // 4-character signature.
        if (shape == typeof(Percent))
            return "Noggog Percent — 25 fields; candidate atomic value, presentation undecided";
        if (shape == typeof(TimeOnly))
            return "TimeOnly — 4 fields; candidate atomic value, presentation undecided";
        if (shape == typeof(RecordType))
            return "Mutagen RecordType signature — 7 fields; candidate atomic value, presentation undecided";

        return null;
    }

    // A Loqui struct whose own sub-schema comes out empty, so there is nothing to present.
    private static string? EmptySubSchemaReason(GameReflection game, Type shape) =>
        game.Annotations.IsEmptySubSchemaType(shape)
            ? "empty sub-schema — see SchemaReflectorLeafCoverageCompletenessTests.KnownGaps"
            : null;

    /// <summary>Every excluded shape's reason, for the audit's own non-vacuity guard.</summary>
    internal static IReadOnlyList<string> ExcludedShapeLabels =>
    [
        .. new[]
        {
            typeof(IGenderedItemGetter<>), typeof(ReadOnlyMemorySlice<>), typeof(IReadOnlyArray2d<>),
            typeof(IReadOnlyDictionary<,>), typeof(Percent), typeof(TimeOnly), typeof(RecordType),
        }.Select(t => ExcludedShapeReason(t)!),
    ];

    internal static bool IsExcludedUnionColumn(PropertyInfo prop, GameReflection game)
    {
        var core = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
        return ReflectedTypes.IsLoquiInterface(core)
            && ReflectedTypes.GetSetterType(core) is { } setterType
            && game.Annotations.IsExcludedUnion(setterType);
    }
}
