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

public sealed class SchemaReflectorLeafCoverageCompletenessTests
{
    private const GameCategory Category = GameCategory.Fallout4;

    private static readonly HashSet<string> HandKeptSkipOfEditorIdTheWritePathOwnsAndGrupTimestampsSoADriftFailsLoud = new(StringComparer.Ordinal)
    {
        "EditorID", "Timestamp", "TemporaryTimestamp", "PersistentTimestamp",
    };

    private static readonly HashSet<string> LoquiSkipProps = new(StringComparer.OrdinalIgnoreCase) { "Registration" };

    private static readonly (string SchemaRegisteredGetterInterfaceName, string Property)[] MandatoryAbstractUnionsANpcLevelAndAQuestAlias =
    [
        ("INpcGetter", "Level"),
        ("IQuestGetter", "Aliases"),
    ];

    private static readonly (string SchemaRegisteredGetterInterfaceName, string Property)[] TwoLevelChainAbstractUnionsAPerkEffectOverAPerkEntryPointEffect =
    [
        ("IPerkGetter", "Effects"),
    ];

    private static readonly (string SchemaRegisteredGetterInterfaceName, string Property)[] CoveredAbstractUnionsNamedSoAByproductTypeQuietlyChangingShapeIsNoticed =
    [
        .. MandatoryAbstractUnionsANpcLevelAndAQuestAlias,
        .. TwoLevelChainAbstractUnionsAPerkEffectOverAPerkEntryPointEffect,
        ("IBookGetter", "Teaches"),
        ("IColorRecordGetter", "Data"),
        ("IHolotapeGetter", "Data"),
        ("ISoundDescriptorGetter", "Data"),
        ("IMagicEffectGetter", "Archetype"),
        ("IAudioEffectChainGetter", "Effects"),
    ];

    private static readonly (string SchemaRegisteredGetterInterfaceName, string Property)[] CoveredNestedAbstractUnionsOfSubrecordsEmbeddedInsideOtherRecordTypes =
    [
        ("INavmeshGeometryGetter", "Parent"),
        ("ILocationTargetRadiusGetter", "Target"),
    ];

    [Fact]
    public void EveryCoveredAbstractUnion_ExposesNonEmptySubSchemaWithADiscriminator()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var regressed = new List<string>();
        foreach (var (owner, property) in CoveredAbstractUnionsNamedSoAByproductTypeQuietlyChangingShapeIsNoticed)
        {
            var schema = schemas.Values.SingleOrDefault(s => s.RecordType.Name == owner);
            if (schema == null) { regressed.Add($"{owner} (schema not found)"); continue; }

            var column = schema.RecordColumns.SingleOrDefault(c => c.PropertyName == property);
            AssertCovered(regressed, $"{owner}.{property}",
                column == null ? null : column.Field.ElementType?.Fields ?? column.Field.Fields);
        }

        foreach (var (owner, property) in CoveredNestedAbstractUnionsOfSubrecordsEmbeddedInsideOtherRecordTypes)
        {
            IReadOnlyList<FieldMetadata>? found = null;
            foreach (var schema in schemas.Values)
            {
                foreach (var column in schema.RecordColumns)
                {
                    var nestedFields = column.Field.ElementType?.Fields ?? column.Field.Fields;
                    if (nestedFields == null) continue;
                    var match = nestedFields.SingleOrDefault(f => f.Name == property);
                    if (match == null) continue;
                    var ownPropWhoseNestedTypeIsReDerivedToExcludeASameNamedPropertyOnAnUnrelatedStruct = DirectDataProperties(schema.RecordType, HandKeptSkipOfEditorIdTheWritePathOwnsAndGrupTimestampsSoADriftFailsLoud)
                        .FirstOrDefault(p => p.Name == column.PropertyName);
                    if (ownPropWhoseNestedTypeIsReDerivedToExcludeASameNamedPropertyOnAnUnrelatedStruct == null
                        || NestedGetterType(ownPropWhoseNestedTypeIsReDerivedToExcludeASameNamedPropertyOnAnUnrelatedStruct.PropertyType)?.Name != owner) continue;
                    found = match.Fields;
                    break;
                }
                if (found != null) break;
            }

            AssertCovered(regressed, $"{owner}.{property}", found);
        }

        Assert.True(regressed.Count == 0,
            $"An abstract-union field the covered abstract-union lists name as " +
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
    public void EveryDirectRecordProperty_IsRepresentedInItsSchemaOrExplicitlyExcluded_ReDerivedFromMutagensReflectionNotTheReflectorsClassificationAcceptingNoGap()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        Assert.True(schemas.Values.Any(s => OwnersOf(s).Count > 1),
            "Expected a table with several sibling owners; otherwise this is the winner-only sweep it replaced and a sibling's own members go unasked for.");

        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            if (HasNoClrGetterTypeBecauseModHeaderIsNeverAnIMajorRecordGetter(schema)) continue;

            foreach (var owner in OwnersOf(schema))
            {
                foreach (var prop in DirectDataProperties(owner, HandKeptSkipOfEditorIdTheWritePathOwnsAndGrupTimestampsSoADriftFailsLoud))
                {
                    if (schema.RecordColumns.Any(c => c.PropertyName == prop.Name || c.Aliases.Contains(prop.Name))) continue;
                    gaps.Add($"{owner.Name}.{prop.Name} (missing from '{schema.TableName}' entirely)");
                }
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops: {string.Join(", ", gaps)}. " +
            "Every member is represented, so a gap here is a defect, not a deferral.");
    }

    [Fact]
    public void EveryPropertyBelowEveryColumn_IsRepresentedOrExplicitlyExcluded_AtWhateverDepthTheRecordGraphGoes()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            if (HasNoClrGetterTypeBecauseModHeaderIsNeverAnIMajorRecordGetter(schema)) continue;

            var ownProperties = OwnersOf(schema).SelectMany(o => DirectDataProperties(o, HandKeptSkipOfEditorIdTheWritePathOwnsAndGrupTimestampsSoADriftFailsLoud)).ToList();
            foreach (var column in schema.RecordColumns)
            {
                foreach (var ownerProp in ownProperties.Where(p => p.Name == column.PropertyName))
                    DescendEveryMemberBelowOneColumnStoppingOnReenteringATypeWhichIsThisTestsOwnCycleRule(gaps, $"{schema.TableName}.{column.PropertyName}", ownerProp.PropertyType, column.Field, []);
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops, below an existing column: {string.Join(", ", gaps)}. " +
            "Every member is represented, so a gap here is a defect, not a deferral.");
    }

    private static bool HasNoClrGetterTypeBecauseModHeaderIsNeverAnIMajorRecordGetter(RecordTableSchema schema) => schema.IsHeader;

    private static void DescendEveryMemberBelowOneColumnStoppingOnReenteringATypeWhichIsThisTestsOwnCycleRule(
        List<string> gaps, string path, Type propertyType, FieldMetadata field, ImmutableHashSet<Type> visited)
    {
        var aMemberAKnownDefectLeftOpaqueIsNamedAndDeliberatelyNotExpanded = field is { ReadOnlyReason: not null, Fields: [] };
        if (aMemberAKnownDefectLeftOpaqueIsNamedAndDeliberatelyNotExpanded) return;
        if (NestedGetterType(propertyType) is not { } nestedType) return;
        var aVectorIsOneTextLeafTheCodecSpellsItselfSoHasNoMembersToReach = IsVectorStructType(nestedType);
        if (aVectorIsOneTextLeafTheCodecSpellsItselfSoHasNoMembersToReach || visited.Contains(nestedType)) return;

        var subFields = SubFieldsOfItsOwnItsElementAndEachLeafVariantSinceAMemberTheLeavesShapeDifferentlyHasNoSingleList(field);
        foreach (var nestedProp in DirectDataProperties(nestedType, LoquiSkipProps))
        {
            var reached = subFields.Where(f => f.Name == nestedProp.Name).ToList();
            if (reached.Count == 0)
            {
                gaps.Add($"{path}.{nestedProp.Name} (-> {nestedType.Name}, missing from '{field.Name}''s own sub-fields)");
                continue;
            }

            foreach (var child in reached)
                DescendEveryMemberBelowOneColumnStoppingOnReenteringATypeWhichIsThisTestsOwnCycleRule(gaps, $"{path}.{nestedProp.Name}", nestedProp.PropertyType, child, visited.Add(nestedType));
        }
    }

    private static IReadOnlyList<FieldMetadata> SubFieldsOfItsOwnItsElementAndEachLeafVariantSinceAMemberTheLeavesShapeDifferentlyHasNoSingleList(FieldMetadata field)
    {
        var shapes = field.Variants?.Values.Prepend(field) ?? [field];
        return [.. shapes.SelectMany(s => s.Fields ?? s.ElementType?.Fields ?? [])];
    }

    private static readonly ILookup<string, Type> EveryGetterInterfaceUnderOneGrupSignatureBecauseATablesColumnsAreTheUnionOfItsSiblingsSoADiscoveryWinnerSweepMissesTheRest =
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
        EveryGetterInterfaceUnderOneGrupSignatureBecauseATablesColumnsAreTheUnionOfItsSiblingsSoADiscoveryWinnerSweepMissesTheRest[schema.TableName] is var siblings && siblings.Any()
            ? [.. siblings]
            : [schema.RecordType];

    private static IEnumerable<PropertyInfo> DirectDataProperties(Type type, HashSet<string> skip)
    {
        return type.GetInterfaces().Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            .Where(p => !skip.Contains(p.Name) && IsAShapeSchemaReflectorsDispatchRecognizesReDerivedNotCalledInto(p.PropertyType))
            .GroupBy(p => p.Name, StringComparer.Ordinal)
            .Select(g => g.First());
    }

    private static Type? NestedGetterType(Type propertyType)
    {
        var core = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
        if (core.IsGenericType && core.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
            core = core.GetGenericArguments()[0];
        if (IsFormLink(core)) return null;
        if (IsLoquiInterface(core)) return core;
        return IsVectorStructType(core) ? core : null;
    }

    private static bool IsAShapeSchemaReflectorsDispatchRecognizesReDerivedNotCalledInto(Type propertyType)
    {
        var core = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
        if (core.IsGenericType && core.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
            core = core.GetGenericArguments()[0];
        return PrimitiveTypesMirroringLeafClassificationPrimitiveMapKeys.Contains(core)
            || typeof(ITranslatedStringGetter).IsAssignableFrom(core)
            || core.IsEnum
            || IsFormLink(core)
            || IsLoquiInterface(core)
            || IsVectorStructType(core);
    }

    private static readonly HashSet<Type> PrimitiveTypesMirroringLeafClassificationPrimitiveMapKeys =
    [
        typeof(bool), typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(long), typeof(ulong), typeof(float), typeof(string),
    ];

    private static bool IsFormLink(Type type) => typeof(IFormLinkGetter).IsAssignableFrom(type);

    private static bool IsLoquiInterface(Type type) =>
        type.IsInterface && !IsFormLink(type)
        && type.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;

    private static readonly HashSet<Type> VectorStructTypesMirroringSchemaAnnotationsVectorStructTypesInEveryGameOmittingP2DoubleP3DoubleP3IntAndTheWrapperTypesWhichHaveZeroUsagesInFo4 =
    [
        typeof(P3Int16), typeof(P3Float),
        typeof(P2Int), typeof(P2UInt8), typeof(P2Int16),
        typeof(P3UInt8), typeof(P3UInt16), typeof(P2Float),
    ];

    private static bool IsVectorStructType(Type type) =>
        VectorStructTypesMirroringSchemaAnnotationsVectorStructTypesInEveryGameOmittingP2DoubleP3DoubleP3IntAndTheWrapperTypesWhichHaveZeroUsagesInFo4.Contains(type);
}
