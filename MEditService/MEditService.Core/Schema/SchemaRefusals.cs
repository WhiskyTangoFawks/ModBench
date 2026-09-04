using System.Reflection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>Everything the reflected schema declines, and the reason it gives: the named reasons a
/// leaf carries no writer, the shapes real data reaches that no one has decided a presentation for,
/// and the anomaly channel a property that lands in no structural class at all reports through.
/// Total classification (#649 commitment 2) is the property this module exists to keep: silence is
/// never an outcome.</summary>
internal static class SchemaRefusals
{
    // #649 commitment 2. Every property the walk reaches lands in exactly one structural class, or
    // says so here. The channel is the ILogger already threaded through every dispatch site rather
    // than a new collector parameter on ten signatures — the audit
    // (SchemaReflectorTotalClassificationTests) builds a schema with a collecting logger and asserts
    // this line never fires.
    //
    // Warning, not Debug: an unclassified property is a field the editor can neither see nor write,
    // which is exactly what #641 and #642 were. It should be loud in a real run too, not only under
    // test.
    internal const string UnclassifiedAnomalyPrefix = "SchemaReflector: unclassified";

    // Every leaf that cannot be written says why, in one of these terms. Shared constants rather
    // than repeated literals so the symmetry audit can enumerate the legitimate reasons and reject
    // anything else — a mass re-declaration (reverting #643, say) would have to invent a new one.

    /// <summary>A discriminator: consumed off the raw JSON to decide which concrete type to build,
    /// before the object it would be applied to exists. Not a gap — the choice it carries is
    /// honoured by that construction rather than by an applier, so SubFieldValues.ApplySubFields deliberately
    /// keeps naming it a silent skip (TargetingRefuses stays false).</summary>
    internal const string DiscriminatorReason =
        "discriminator: read off the payload to choose a concrete type, before that object exists";

    /// <summary>An element-shape template carried by a list's metadata. A list is written as one whole
    /// value through its owning field, so the template itself is never a write target.</summary>
    internal const string ElementTemplateReason =
        "list element template: a list is written as one whole value through its owning field";

    /// <summary>A list whose element type <see cref="SubFieldReflection.BuildElementMeta"/> classifies for reading but
    /// <see cref="ListLeaves.BuildListElement"/> has no arm to build: a translated string, or an integer width
    /// <see cref="LeafClassification.PrimitiveMap"/> lacks while <c>ReflectedTypes.IntegerTypes</c> carries it. No Fallout 4 leaf is
    /// either, so this keeps the classification total rather than describing live data. Only
    /// <see cref="ListLeaves.BuildListColumn"/> produces it.
    /// </summary>
    internal const string UnconvertibleElementListReason =
        "list element: the element type has no JSON converter, so no element can be built from a payload";

    /// <summary>A leaf whose LeafSpec produced no converter and is neither a form link nor a byte
    /// slice. Not reachable for any shape LeafClassification.ClassifyLeaf currently returns — every one of them has a
    /// converter or is one of those two — so this is the honest name for a branch that exists to
    /// keep the choice total.</summary>
    internal const string NoConverterReason =
        "leaf with no JSON converter and no form-link write path";

    /// <summary>The plugin header's author/flags. #633 deleted the header write path deliberately;
    /// since #661 a write genuinely reaches these columns and is refused here rather than at a gate.</summary>
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

    // #649 commitment 2's third outcome, and a first-class one: a shape the walk genuinely reaches
    // and could present, that no one has yet decided a presentation for, is named here rather than
    // silently dropped. Counts are LIVE, from the audit's own enumeration over Fallout 4 — never from
    // a grep over Mutagen's sources, which found ~76% of this population and none of the shapes that
    // actually needed a decision (see SchemaReflectorTotalClassificationTests).
    //
    // Promotion out of this list is always available: Color sat here in spirit until #649 gave it a
    // presentation-table entry, and the atomic-value mechanism it now uses is ready for more. Each
    // reason therefore says what a future ticket would have to decide, not merely that it is absent.
    internal static string? ExcludedShapeReason(Type shape)
    {
        var open = shape.IsGenericType ? shape.GetGenericTypeDefinition() : null;

        // FOUND AND SIZED, NOT OVERLOOKED — 20 fields, enumerated in
        // SchemaReflectorTotalClassificationTests.GenderedItemFields. Mutagen's Male/Female pair
        // wrapper (Mutagen.Bethesda.Core/Plugins/Records/GenderedItem.cs:17 — a plain generic
        // interface with no StaticRegistration, which is exactly why ReflectedTypes.IsLoquiInterface declines it and
        // it fell through the old silent default). It carries ordinary modding content: Race height,
        // head data, skeletal model and voices per sex; ArmorAddon world/first-person models, skin
        // texture and priority per sex; faction rank titles per sex. It is invisible and unwritable
        // for the same reason Color was before #649, at a third of Color's scale.
        //
        // Deferred, not dropped: presenting a gendered pair is a NEW RENDERED SHAPE and needs its own
        // xEdit-shape decision (two sub-rows? a two-column split? something else?) the way Color got a
        // live triage session and a maintainer-confirmed representation before it was built. That is a
        // maintainer call, not a mid-slice one.
        if (open == typeof(IGenderedItemGetter<>))
            return "gendered Male/Female pair — 20 fields; real data, deferred pending a presentation decision";

        // 2 fields: Weather.CloudTextures (a slice of String) and Weather.NAM4 (a slice of Single).
        // A slice of typed elements is a list shape; only a byte slice has a hex reading, and the
        // element-type test is what keeps a byte slice reaching an untaught site loud rather than
        // dropped under a reason that would be false of it.
        if (open == typeof(ReadOnlyMemorySlice<>) && !ByteSliceHex.IsByteSlice(shape))
            return "non-byte element slice — 2 fields; an array of typed elements, not a hex blob";

        // 4 fields: LandscapeVertexHeightMap-style grids. Real data, tiny population, no grid shape.
        if (open == typeof(IReadOnlyArray2d<>))
            return "2D array grid — 4 fields; no grid presentation exists";

        // 2 fields: Race.BipedObjects (keyed by BipedObject) and Package.Data (keyed by SByte). Real
        // data; a keyed map is a shape neither the schema's array nor its struct model covers.
        if (open == typeof(IReadOnlyDictionary<,>))
            return "keyed map — 2 fields; neither the array nor the struct model covers a dictionary";

        // Candidate atomic-value table entries — the mechanism Color now uses is ready for each, but
        // each is a new rendered leaf needing its own xEdit-shape decision first. Percent is a ratio
        // xEdit shows as a raw float; TimeOnly is Climate's sunrise/sunset, which xEdit shows as a
        // byte in 10-minute increments; RecordType is a 4-character signature.
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
