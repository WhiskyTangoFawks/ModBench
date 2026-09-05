using System.Reflection;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Tests.Indexing;

/// <summary>Re-derives "is this property in the schema" from Mutagen's reflection rather than the
/// reflector's classification, depth-capped at two levels to avoid a tautology.</summary>
public sealed class SchemaReflectorLeafCoverageCompletenessTests
{
    private const GameCategory Category = GameCategory.Fallout4;

    // Record-header metadata and Loqui's Registration handle, never per-record data at any depth. A
    // hand-kept mirror by name rather than a reference, so a drift fails as a loud false-positive gap.
    private static readonly HashSet<string> BaseSkip = new(StringComparer.Ordinal)
    {
        "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl", "MajorRecordFlagsRaw",
        "Timestamp", "TemporaryTimestamp", "PersistentTimestamp",
    };

    private static readonly HashSet<string> LoquiSkipProps = new(StringComparer.OrdinalIgnoreCase) { "Registration" };

    // Known, accepted gaps, keyed (OwnerType.Name, PropertyName) at whichever depth the pair is
    // walked — every one named and explained, never passed over silently.
    private static readonly HashSet<(string Owner, string Property)> KnownGaps = new()
    {
        // ASceneActionType is the one union base Mutagen leaves non-abstract on purpose: expanding
        // it would crash on SceneActionTypicalType's throwing overlay getter
        // (docs/specs/medit-record-editor.md).
        ("ISceneActionGetter", "Type"),

        // A false positive of this test's own column-name matching. DamageType and
        // DamageTypeIndexed declare `DamageTypes` with different shapes, and MergeSiblingColumn resolves
        // the disagreement by renaming, which a PropertyName-based lookup does not account for.
        ("IDamageTypeItemGetter", "ActorValue"),
        ("IDamageTypeItemGetter", "Spell"),
    };

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
                column == null ? null : column.IsArray ? column.ElementType?.Fields : column.SubFields);
        }

        // The nested set: found one level inside whichever record's own column reaches this getter
        // type, mirroring EveryStructOrArrayColumns_...'s own NestedGetterType walk rather than a
        // second, bespoke lookup.
        foreach (var (owner, property) in CoveredNestedAbstractUnions)
        {
            IReadOnlyList<FieldMetadata>? found = null;
            foreach (var schema in schemas.Values)
            {
                foreach (var column in schema.RecordColumns)
                {
                    var nestedFields = column.IsArray ? column.ElementType?.Fields : column.SubFields;
                    if (nestedFields == null) continue;
                    var match = nestedFields.SingleOrDefault(f => f.Name == property);
                    if (match == null) continue;
                    // Confirm this column's own nested type is really `owner`, not a same-named
                    // property on some unrelated struct — cheap enough: re-derive via NestedGetterType.
                    var ownProp = DirectDataProperties(schema.RecordType, BaseSkip)
                        .FirstOrDefault(p => p.Name == column.PropertyName);
                    if (ownProp == null || NestedGetterType(ownProp.PropertyType)?.Name != owner) continue;
                    found = match.Fields;
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

        static void AssertCovered(List<string> regressed, string label, IReadOnlyList<FieldMetadata>? fields)
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
        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            // ModHeader is never an IMajorRecordGetter — no CLR getter type of its own for this sweep to walk.
            if (schema.IsHeader) continue;

            foreach (var prop in DirectDataProperties(schema.RecordType, BaseSkip))
            {
                if (KnownGaps.Contains((schema.RecordType.Name, prop.Name))) continue;
                if (prop.Name == "VirtualMachineAdapter"
                    && typeof(IHaveVirtualMachineAdapterGetter).IsAssignableFrom(schema.RecordType))
                    continue;
                if (schema.RecordColumns.Any(c => c.PropertyName == prop.Name)) continue;
                gaps.Add($"{schema.RecordType.Name}.{prop.Name} (missing from '{schema.TableName}' entirely)");
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops: {string.Join(", ", gaps)}. " +
            "Either give it a ColumnSpec mapping, or add a named, commented exclusion to KnownGaps.");
    }

    [Fact]
    public void EveryStructOrArrayColumns_OwnDirectProperties_AreRepresentedOrExplicitlyExcluded()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            if (schema.IsHeader) continue;

            var ownProperties = DirectDataProperties(schema.RecordType, BaseSkip).ToList();
            foreach (var column in schema.RecordColumns)
            {
                var ownerProp = ownProperties.FirstOrDefault(p => p.Name == column.PropertyName);
                if (ownerProp == null) continue; // not this schema's own property (e.g. sibling-shape merge) — depth-0 test covers it on its own type
                if (NestedGetterType(ownerProp.PropertyType) is not { } nestedType) continue;
                // A vector is one text leaf the codec spells itself ("x, y, z"), so it has no members to reach.
                if (IsVectorStructType(nestedType)) continue;

                var subFields = column.IsArray ? column.ElementType?.Fields : column.SubFields;
                foreach (var nestedProp in DirectDataProperties(nestedType, LoquiSkipProps))
                {
                    if (KnownGaps.Contains((nestedType.Name, nestedProp.Name))) continue;

                    if (subFields != null && subFields.Any(f => f.Name == nestedProp.Name)) continue;

                    gaps.Add($"{schema.RecordType.Name}.{column.PropertyName}.{nestedProp.Name} " +
                        $"(-> {nestedType.Name}, missing from '{column.Name}''s own sub-fields)");
                }
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops, one level inside an existing column: {string.Join(", ", gaps)}. " +
            "Either give it a sub-field mapping, or add a named, commented exclusion to KnownGaps.");
    }

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
