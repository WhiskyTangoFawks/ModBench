using System.Collections.Immutable;
using System.Reflection;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Codec.Tests.Indexing;

/// <summary>Re-derives "is this property in the schema" from Mutagen's reflection rather than the
/// reflector's classification, to whatever depth the record graph goes, and accepts no gap.</summary>
public sealed class SchemaReflectorLeafCoverageCompletenessTests
{
    private const GameCategory Category = GameCategory.Fallout4;

    // Record-header metadata and Loqui's Registration handle, never per-record data at any depth. A
    // hand-kept copy by name rather than a reference, so a drift fails as a loud false-positive gap.
    private static readonly HashSet<string> BaseSkip = new(StringComparer.Ordinal)
    {
        "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl", "MajorRecordFlagsRaw",
        "Timestamp", "TemporaryTimestamp", "PersistentTimestamp",
    };

    private static readonly HashSet<string> LoquiSkipProps = new(StringComparer.OrdinalIgnoreCase) { "Registration" };

    // Named here rather than left as an incidental byproduct, so a byproduct type quietly changing
    // shape does not go unnoticed. Owner is a schema-registered getter interface name; the nested list
    // below holds subrecords embedded inside other record types.
    private static readonly (string Owner, string Property)[] CoveredAbstractUnions =
    [
        ("INpcGetter", "Level"),                    // ANpcLevel: NpcLevel / PcLevelMult — mandatory
        ("IQuestGetter", "Aliases"),                 // AQuestAlias: QuestReferenceAlias / QuestLocationAlias / QuestCollectionAlias — mandatory
        ("IBookGetter", "Teaches"),                  // BookTeachTarget
        ("IColorRecordGetter", "Data"),              // AColorRecordData
        ("IHolotapeGetter", "Data"),                 // AHolotapeData
        ("ISoundDescriptorGetter", "Data"),          // ASoundDescriptor
        ("IPerkGetter", "Effects"),                  // APerkEffect / APerkEntryPointEffect (two-level chain)
        ("IMagicEffectGetter", "Archetype"),         // AMagicEffectArchetype
        ("IAudioEffectChainGetter", "Effects"),      // AAudioEffect
    ];

    private static readonly (string Owner, string Property)[] CoveredNestedAbstractUnions =
    [
        ("INavmeshGeometryGetter", "Parent"),        // ANavmeshParent
        ("ILocationTargetRadiusGetter", "Target"),   // ALocationTarget
    ];

    [Fact]
    public void EveryCoveredAbstractUnion_ExposesNonEmptySubSchemaWithADiscriminator()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var regressed = new List<string>();
        foreach (var (owner, property) in CoveredAbstractUnions)
        {
            var schema = schemas.Values.SingleOrDefault(s => s.RecordType.Name == owner);
            if (schema == null) { regressed.Add($"{owner} (schema not found)"); continue; }

            var column = schema.RecordColumns.SingleOrDefault(c => c.PropertyName == property);
            AssertCovered(regressed, $"{owner}.{property}",
                column == null ? null : column.Field.IsArray ? column.Field.ElementSpec?.SubFields : column.Field.SubFields);
        }

        // The nested set: found one level inside whichever record's own column reaches this getter
        // type, mirroring EveryStructOrArrayColumns_...'s own NestedGetterType walk rather than a
        // second, bespoke lookup.
        foreach (var (owner, property) in CoveredNestedAbstractUnions)
        {
            IReadOnlyList<SubFieldSpec>? found = null;
            foreach (var schema in schemas.Values)
            {
                foreach (var column in schema.RecordColumns)
                {
                    var nestedFields = column.Field.IsArray ? column.Field.ElementSpec?.SubFields : column.Field.SubFields;
                    if (nestedFields == null) continue;
                    var match = nestedFields.SingleOrDefault(f => f.Name == property);
                    if (match == null) continue;
                    // Confirm this column's own nested type is really `owner`, not a same-named
                    // property on some unrelated struct — cheap enough: re-derive via NestedGetterType.
                    var ownProp = DirectDataProperties(schema.RecordType, BaseSkip)
                        .FirstOrDefault(p => p.Name == column.PropertyName);
                    if (ownProp == null || NestedGetterType(ownProp.PropertyType)?.Name != owner) continue;
                    found = match.SubFields;
                    break;
                }
                if (found != null) break;
            }

            AssertCovered(regressed, $"{owner}.{property}", found);
        }

        Assert.True(regressed.Count == 0,
            $"An abstract-union field CoveredAbstractUnions/CoveredNestedAbstractUnions names as " +
            $"covered regressed: {string.Join(", ", regressed)}. Either the general mechanism no " +
            "longer reaches it, or it was never actually covered and this list is wrong — " +
            "investigate, don't just remove it.");

        static void AssertCovered(List<string> regressed, string label, IReadOnlyList<SubFieldSpec>? fields)
        {
            if (fields == null || fields.Count == 0)
            {
                regressed.Add($"{label} (empty or missing sub-schema)");
                return;
            }
            if (fields.All(f => !f.IsDiscriminator))
                regressed.Add($"{label} (no discriminator)");
        }
    }

    [Fact]
    public void EveryDirectRecordProperty_IsRepresentedInItsSchemaOrExplicitlyExcluded()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        // Or this is the winner-only sweep it replaced, and a sibling's own members go unasked for.
        Assert.Contains(schemas.Values, s => OwnersOf(s).Count > 1);

        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            // ModHeader is never an IMajorRecordGetter — no CLR getter type of its own for this sweep to walk.
            if (schema.IsHeader) continue;

            foreach (var owner in OwnersOf(schema))
            {
                foreach (var prop in DirectDataProperties(owner, BaseSkip))
                {
                    if (schema.RecordColumns.Any(c => c.PropertyName == prop.Name)) continue;
                    gaps.Add($"{owner.Name}.{prop.Name} (missing from '{schema.TableName}' entirely)");
                }
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops: {string.Join(", ", gaps)}. " +
            "Every member is represented, so a gap here is a defect, not a deferral.");
    }

    [Fact]
    public void EveryPropertyBelowEveryColumn_IsRepresentedOrExplicitlyExcluded()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            if (schema.IsHeader) continue;

            var ownProperties = OwnersOf(schema).SelectMany(o => DirectDataProperties(o, BaseSkip)).ToList();
            foreach (var column in schema.RecordColumns)
            {
                foreach (var ownerProp in ownProperties.Where(p => p.Name == column.PropertyName))
                    Descend(gaps, $"{schema.TableName}.{column.PropertyName}", ownerProp.PropertyType, column.Field, []);
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops, below an existing column: {string.Join(", ", gaps)}. " +
            "Every member is represented, so a gap here is a defect, not a deferral.");
    }

    // Every member of every type reachable below one column, to whatever depth the record graph
    // goes. Stops on re-entering a type, which is this test's own cycle rule.
    private static void Descend(
        List<string> gaps, string path, Type propertyType, SubFieldSpec field, ImmutableHashSet<Type> visited)
    {
        // A member a known defect governs is named and deliberately not expanded; naming it is what
        // this sweep asks of the schema.
        if (field.ReadOnlyReason != null) return;
        if (NestedGetterType(propertyType) is not { } nestedType) return;
        // A vector is one text leaf the codec spells itself ("x, y, z"), so it has no members to reach.
        if (IsVectorStructType(nestedType) || visited.Contains(nestedType)) return;

        var subFields = SubFieldsOf(field);
        foreach (var nestedProp in DirectDataProperties(nestedType, LoquiSkipProps))
        {
            var reached = subFields.Where(f => f.Name == nestedProp.Name).ToList();
            if (reached.Count == 0)
            {
                gaps.Add($"{path}.{nestedProp.Name} (-> {nestedType.Name}, missing from '{field.Name}''s own sub-fields)");
                continue;
            }

            foreach (var child in reached)
                Descend(gaps, $"{path}.{nestedProp.Name}", nestedProp.PropertyType, child, visited.Add(nestedType));
        }
    }

    // A field's members wherever it carries them: its own, its element's, and each leaf variant's,
    // since a member the leaves shape differently has no single sub-field list.
    private static IReadOnlyList<SubFieldSpec> SubFieldsOf(SubFieldSpec field)
    {
        var shapes = field.Variants?.Values.Prepend(field) ?? [field];
        return [.. shapes.SelectMany(s => s.SubFields ?? s.ElementSpec?.SubFields ?? [])];
    }

    // Every getter interface the game registers under one GRUP signature. A table's columns are the
    // union of its siblings', so a sweep keyed to the discovery winner alone would miss the rest.
    private static readonly ILookup<string, Type> SiblingsBySignature =
        typeof(INpcGetter).Assembly.GetTypes()
            .Where(t => t is { IsAbstract: false, IsInterface: false }
                && typeof(IFallout4MajorRecordGetter).IsAssignableFrom(t))
            .Select(t => (Grup: t.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static), Class: t))
            .SelectMany(x => x.Grup is not { } grup
                ? []
                : new[]
                {
                    (
                        Signature: ((RecordType)RequireGrupValue(grup, x.Class)).Type.ToLowerInvariant(),
                        Getter: RequireGetterType(x.Class)
                    ),
                })
            .ToLookup(x => x.Signature, x => x.Getter, StringComparer.OrdinalIgnoreCase);

    private static object RequireGrupValue(FieldInfo field, Type owner) =>
        field.GetValue(null) ?? throw new InvalidOperationException($"Expected '{owner.Name}'.GrupRecordType to have a value.");

    private static Type RequireGetterType(Type concreteClass) =>
        typeof(INpcGetter).Assembly.GetType($"Mutagen.Bethesda.Fallout4.I{concreteClass.Name}Getter")
            ?? throw new InvalidOperationException($"Expected getter type 'I{concreteClass.Name}Getter' to exist.");

    private static IReadOnlyList<Type> OwnersOf(RecordTableSchema schema) =>
        SiblingsBySignature[schema.TableName] is var siblings && siblings.Any()
            ? [.. siblings]
            : [schema.RecordType];

    // The same interface-hierarchy walk SchemaReflector's GetAllInterfaceProperties does, re-derived
    // here because it is private.
    private static IEnumerable<PropertyInfo> DirectDataProperties(Type type, HashSet<string> skip)
    {
        return type.GetInterfaces().Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            .Where(p => !skip.Contains(p.Name) && IsRecognizedShape(p.PropertyType))
            .GroupBy(p => p.Name, StringComparer.Ordinal)
            .Select(g => g.First());
    }

    // A property's nested getter type, one level in. Null for a plain scalar, enum, FormLink or
    // translated-string leaf and for a list of one of those: nothing to walk further into.
    private static Type? NestedGetterType(Type propertyType)
    {
        var core = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
        if (core.IsGenericType && core.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
            core = core.GetGenericArguments()[0];
        if (IsFormLink(core)) return null;
        if (IsLoquiInterface(core)) return core;
        return IsVectorStructType(core) ? core : null;
    }

    // This class's own scope boundary (see the class doc comment): a shape SchemaReflector's
    // dispatch already recognizes somewhere (ClassifyLeaf's four leaf kinds, IsListType,
    // IsLoquiInterface, IsVectorStructType) — independently re-derived, not called into.
    private static bool IsRecognizedShape(Type propertyType)
    {
        var core = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
        if (core.IsGenericType && core.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
            core = core.GetGenericArguments()[0];
        return PrimitiveTypes.Contains(core)
            || typeof(ITranslatedStringGetter).IsAssignableFrom(core)
            || core.IsEnum
            || IsFormLink(core)
            || IsLoquiInterface(core)
            || IsVectorStructType(core);
    }

    // Mirrors LeafClassification.PrimitiveMap's key set.
    private static readonly HashSet<Type> PrimitiveTypes =
    [
        typeof(bool), typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(long), typeof(ulong), typeof(float), typeof(string),
    ];

    private static bool IsFormLink(Type type) => typeof(IFormLinkGetter).IsAssignableFrom(type);

    private static bool IsLoquiInterface(Type type) =>
        type.IsInterface && !IsFormLink(type)
        && type.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;

    // Mirrors ReflectedTypes.VectorStructTypes: every Noggog vector struct actually reachable in FO4's
    // schema graph, verified by grepping references/Mutagen. The siblings left out (P2Double,
    // P3Double, P3Int, the wrapper types) have zero usages in FO4's record graph.
    private static readonly HashSet<Type> VectorStructTypes =
    [
        typeof(P3Int16), typeof(P3Float),
        typeof(P2Int), typeof(P2UInt8), typeof(P2Int16),
        typeof(P3UInt8), typeof(P3UInt16), typeof(P2Float),
    ];

    private static bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type);
}
