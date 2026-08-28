using System.Reflection;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #541's third acceptance criterion: a reflector test that walks Mutagen's own type graph for one
/// game and asserts no property of a schema-registered record type is silently dropped from the
/// reflected schema without an explicit, commented exclusion — so this class of gap (P3Int16/
/// P3Float leaves, a list nested inside a struct; before that VMAD, condition-owning fields) fails a
/// test instead of needing a manual per-record-type audit
/// (<c>docs/research/record-type-audit/</c>, deleted with #254).
///
/// <para>Modeled directly on the existing sweep for a different field class,
/// <c>MEditService.Tests.Source.ContainerChildFieldsCompletenessTests</c>: independently re-derive
/// the fact under test (here, "does this property exist on the getter interface, and is it
/// represented in the schema") using Mutagen's own reflection rather than calling back into
/// <see cref="SchemaReflector"/>'s own private classification, then cross-check the two. A handful
/// of trivial one-line predicates below (<see cref="IsLoquiInterface"/>, <see cref="IsP3Type"/>, ...)
/// necessarily mirror <c>SchemaReflector</c>'s own — they are shape tests, not the classification
/// decision this file exists to check, the same distinction that sweep's own doc comment draws.</para>
///
/// <para><b>Deliberately depth-capped at two levels</b> — a record's own direct properties
/// (<see cref="EveryDirectRecordProperty_IsRepresentedInItsSchemaOrExplicitlyExcluded"/>), and one
/// level into any struct/array column's own element type
/// (<see cref="EveryStructOrArrayColumns_OwnDirectProperties_AreRepresentedOrExplicitlyExcluded"/>)
/// — rather than walking arbitrarily deep. Going further would mean re-deriving
/// <c>SchemaReflector</c>'s own recursive dispatch structurally in the test: a tautology (the
/// assertion recomputing the expected value the way the code does), and #541's own two gaps are both
/// within two levels — <c>ObjectBounds</c> at depth 0 (the whole column was missing), <c>Destructible
/// .Resistances/Stages</c> at depth 1 (present column, missing sub-fields). Provably not vacuous:
/// reverting either fix in isolation reproduces a named failure here (verified — see each fix's own
/// commit; <c>Container.ObjectBounds</c> and <c>IDestructibleGetter.Resistances</c>/<c>Stages</c> are
/// exactly the two gaps this suite named red before #541 landed).</para>
///
/// <para><b>Scoped to shapes SchemaReflector's own dispatch vocabulary already recognizes</b>
/// (<see cref="IsRecognizedShape"/>: primitive, translated string, enum, form-link, Loqui struct,
/// P3Int16/P3Float, or a list of one of those) — not "every property of every type, however wire-
/// encoded." A first version of this sweep without that filter found several more currently-real
/// gaps of a <i>different</i> kind: <c>System.Drawing.Color</c> fields (e.g. every
/// <c>WeatherColor</c> member) and raw <c>ReadOnlyMemorySlice&lt;byte&gt;</c> blobs (e.g.
/// <c>Model.Data</c>) that <c>SchemaReflector</c> has never had a case for at all, on any type, ever
/// — a materially bigger, unplanned audit, reported to the orchestrator rather than folded in
/// silently. #541's own two gaps are both shapes the reflector demonstrably <i>does</i> handle
/// elsewhere (a P3Int16 leaf failing only for <c>ObjectBounds</c>'s two properties; a struct-nested
/// list failing only because <c>GetSubFieldInfo</c>, unlike <c>GetColumnInfo</c>, never had an
/// <c>IsListType</c> arm) — a recognized shape falling through a specific crack, which is the class
/// this test exists to catch. An unrecognized shape falling through everywhere, on every type, is a
/// different and larger problem than #541's own "leaf coverage" framing names.</para>
/// </summary>
public sealed class SchemaReflectorLeafCoverageCompletenessTests
{
    private const GameCategory Category = GameCategory.Fallout4;

    // SchemaReflector.BaseSkip — record-header metadata (FormKey, EditorID, ...), not per-record
    // data; SchemaReflector.LoquiSkipProps — Loqui's own infrastructure members on a sub-record
    // interface (CommonInstance, StaticRegistration, ...), never real data at any depth. Both are
    // `private` (InternalsVisibleTo doesn't reach private), so this is a deliberate, small,
    // hand-kept mirror rather than a reference — a drift here fails as a false-positive gap, loudly,
    // not silently, which is the failure mode this suite is supposed to prefer.
    private static readonly HashSet<string> BaseSkip = new(StringComparer.Ordinal)
    {
        "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl",
        "MajorRecordFlagsRaw", "SubgraphRevision",
        "Timestamp", "TemporaryTimestamp", "PersistentTimestamp",
    };

    private static readonly HashSet<string> LoquiSkipProps = new(StringComparer.OrdinalIgnoreCase)
    {
        "CommonInstance", "CommonSetterInstance", "CommonSetterTranslationInstance",
        "StaticRegistration", "Registration",
    };

    // Known, accepted gaps — every one named and explained, never passed over silently. (OwnerType
    // .Name, PropertyName) at whichever depth the pair is walked. Discovered running this sweep
    // during #541's own implementation; every one reported to the orchestrator, not folded in
    // silently — none is P3Int16/P3Float or a struct-nested list, so none is this issue's to fix.
    private static readonly HashSet<(string Owner, string Property)> KnownGaps = new()
    {
        // ── Category 1: Noggog's small value-vector struct family, beyond P3Int16/P3Float (#546,
        // filed, tracked separately) ──────────────────────────────────────────────────────────────
        // Cell.Grid is the one concrete instance this sweep finds: ICellGridGetter's only member,
        // Point, is a Noggog.P2Int (not one of #541's two types — IsRecognizedShape correctly does
        // not flag Point itself, since an entirely unrecognized shape is a different problem than
        // this test's own scope, per the class doc comment). An all-unrecognized-members struct
        // still reflects as zero sub-fields, which BuildStructColumn treats as "no column at all"
        // (subFields.Count == 0) — the same "empty struct column" shape ObjectBounds had before
        // #541 fixed it. Named here explicitly so #546's executor has a starting point.
        ("ICellGetter", "Grid"),

        // ── Category 2: abstract Loqui "leaf union" types — a base interface (Mutagen's own "A<Name>"
        // naming convention: ABookTeachTarget, AColorRecordData, AHolotapeData, ANpcLevel,
        // AQuestAlias, ANavmeshParent, ALocationTarget, ASceneActionType, ...) whose real per-
        // subclass data lives on named sibling leaf interfaces it never inherits from, the same shape
        // #360 already solved narrowly for exactly one case (OMOD's own Properties element,
        // BuildObjectModPropertyLeafFields — "the real per-element data lives on 7 separate leaf
        // getter interfaces... rather than the other way around, so none of their own members are
        // ever reached by [a plain interface] walk alone"). Every one of these is a genuinely bigger,
        // separate undertaking than #541 (a discriminator scheme per abstract type, #360's own
        // per-case verification work) — reported to the orchestrator as a new, material finding, not
        // silently swept into this exclusion list. Not P3-related; not a struct-nested list.
        ("IBookGetter", "Teaches"),               // BookTeachTarget
        ("IColorRecordGetter", "Data"),           // AColorRecordData
        ("IHolotapeGetter", "Data"),              // AHolotapeData
        ("INpcGetter", "Level"),                  // ANpcLevel
        ("IQuestGetter", "Aliases"),               // IReadOnlyList<AQuestAlias> — list of abstract union
        ("ISoundDescriptorGetter", "Data"),       // ASoundDescriptorData
        ("INavmeshGeometryGetter", "Parent"),     // ANavmeshParent (Activator/Furniture/Static's own NavmeshGeometry)
        ("ILocationTargetRadiusGetter", "Target"),// ALocationTarget (Faction.VendorLocation)
        ("ISceneActionGetter", "Type"),           // ASceneActionType

        // ── Category 3: a real, non-abstract Loqui struct whose only members are themselves an
        // unrecognized shape (same "empty struct column" mechanics as Category 1, different member
        // type — a raw byte blob rather than a Noggog vector struct). ScenePhaseUnusedData appears
        // on both Scene's own phase data and SceneAction; the same reason both are named.
        ("ISceneGetter", "Unused"),                // ScenePhaseUnusedData
        ("ISceneGetter", "Unused2"),               // ScenePhaseUnusedData
        ("ISceneActionGetter", "Unused"),          // ScenePhaseUnusedData
        ("IWorldspaceGetter", "MaxHeight"),        // WorldspaceMaxHeight
        ("IWorldspaceGetter", "MapData"),          // WorldspaceMap
        ("IWorldspaceGetter", "DefaultLevelData"), // WorldDefaultLevelData

        // ── Category 4: not a reflector gap at all — a false positive of this test's own simplistic
        // column-name matching against #263's sibling-shape merge. DamageType and its sibling
        // DamageTypeIndexed share one GRUP signature and both declare a `DamageTypes` property with
        // *different* shapes (IReadOnlyList<IDamageTypeItemGetter> vs IReadOnlyList<UInt32>) —
        // MergeSiblingColumn's own widening machinery (already covered by its own tests) resolves
        // that disagreement by renaming, which this sweep's PropertyName-based lookup doesn't
        // account for. DamageTypeItem.ActorValue/.Spell are ordinary FormLink members and are not,
        // in fact, missing from the merged column — verified by reading DamageType_Generated.cs /
        // DamageTypeIndexed_Generated.cs, not assumed.
        ("IDamageTypeItemGetter", "ActorValue"),
        ("IDamageTypeItemGetter", "Spell"),
    };

    [Fact]
    public void EveryDirectRecordProperty_IsRepresentedInItsSchemaOrExplicitlyExcluded()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var conditionCodec = ConditionCodecRegistry.For(Category);

        var gaps = new List<string>();
        foreach (var schema in schemas.Values)
        {
            // ModHeader is never an IMajorRecordGetter (RecordTableSchema's own doc comment on
            // HeaderColumnExtract) — no CLR getter type of its own for this sweep to walk.
            if (schema.HeaderColumnExtract != null) continue;

            foreach (var prop in DirectDataProperties(schema.RecordType, BaseSkip))
            {
                if (KnownGaps.Contains((schema.RecordType.Name, prop.Name))) continue;
                if (prop.Name == "VirtualMachineAdapter"
                    && typeof(IHaveVirtualMachineAdapterGetter).IsAssignableFrom(schema.RecordType))
                    continue;
                if (conditionCodec != null && conditionCodec.IsConditionListField(schema.RecordType, prop.Name))
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
            if (schema.HeaderColumnExtract != null) continue;

            var ownProperties = DirectDataProperties(schema.RecordType, BaseSkip).ToList();
            foreach (var column in schema.RecordColumns)
            {
                var ownerProp = ownProperties.FirstOrDefault(p => p.Name == column.PropertyName);
                if (ownerProp == null) continue; // not this schema's own property (e.g. #263 merge) — depth-0 test covers it on its own type
                if (NestedGetterType(ownerProp.PropertyType) is not { } nestedType) continue;

                var subFields = column.IsArray ? column.ElementType?.Fields : column.SubFields;
                foreach (var nestedProp in DirectDataProperties(nestedType, LoquiSkipProps))
                {
                    if (KnownGaps.Contains((nestedType.Name, nestedProp.Name))) continue;

                    var expectedName = SchemaReflector.ToSnakeCase(nestedProp.Name);
                    if (subFields != null && subFields.Any(f => f.Name == expectedName)) continue;

                    gaps.Add($"{schema.RecordType.Name}.{column.PropertyName}.{nestedProp.Name} " +
                        $"(-> {nestedType.Name}, missing from '{column.Name}''s own sub-fields)");
                }
            }
        }

        Assert.True(gaps.Count == 0,
            $"SchemaReflector silently drops, one level inside an existing column: {string.Join(", ", gaps)}. " +
            "Either give it a sub-field mapping, or add a named, commented exclusion to KnownGaps.");
    }

    // Every property this type's own Getter-interface hierarchy declares, deduplicated by name and
    // restricted to IsRecognizedShape (see this class's own doc comment for why) — the same
    // interface-hierarchy walk SchemaReflector's own GetAllInterfaceProperties does
    // (type.GetInterfaces().Append(type)...), independently re-derived here rather than called into
    // (it is `private`), which is the same posture ContainerChildFieldsCompletenessTests already
    // takes for its own equivalent walk.
    //
    // P3Int16/P3Float are special-cased to exactly X/Y/Z rather than a generic property walk,
    // mirroring SchemaReflector.BuildP3ComponentSubFields' own explicit scope: both types carry real
    // geometry-helper properties (Length, Magnitude, SqrMagnitude, Normalized, Absolute) that are
    // computed, not serialized data, and P3Int16's own Point (`P3Int16 Point => this`) is
    // self-referencing — "all public properties" is the wrong model of "this type's own data" for
    // exactly these two types, the same reason BuildP3ComponentSubFields itself is a fixed 3-name
    // list rather than a property walk.
    private static IEnumerable<PropertyInfo> DirectDataProperties(Type type, HashSet<string> skip)
    {
        if (IsP3Type(type))
        {
            return new[] { "X", "Y", "Z" }
                .Select(n => type.GetProperty(n, BindingFlags.Public | BindingFlags.Instance)!);
        }

        return type.GetInterfaces().Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            .Where(p => !skip.Contains(p.Name) && IsRecognizedShape(p.PropertyType))
            .GroupBy(p => p.Name, StringComparer.Ordinal)
            .Select(g => g.First());
    }

    // A property's own nested getter type, one level in — a Loqui struct, a P3Int16/P3Float, or
    // (for a list column) whichever of those its element type is. Null for a plain scalar/enum/
    // FormLink/translated-string leaf and for a list of one of those: nothing to walk further into.
    private static Type? NestedGetterType(Type propertyType)
    {
        var core = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
        if (core.IsGenericType && core.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
            core = core.GetGenericArguments()[0];
        if (IsFormLink(core)) return null;
        if (IsLoquiInterface(core)) return core;
        return IsP3Type(core) ? core : null;
    }

    // This class's own scope boundary (see the class doc comment): a shape SchemaReflector's
    // dispatch already recognizes somewhere (ClassifyLeaf's four leaf kinds, IsListType,
    // IsLoquiInterface, IsP3Type) — independently re-derived, not called into.
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
            || IsP3Type(core);
    }

    // Mirrors SchemaReflector.PrimitiveMap's key set.
    private static readonly HashSet<Type> PrimitiveTypes =
    [
        typeof(bool), typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(ulong), typeof(float), typeof(string),
    ];

    private static bool IsFormLink(Type type) => typeof(IFormLinkGetter).IsAssignableFrom(type);

    private static bool IsLoquiInterface(Type type) =>
        type.IsInterface && !IsFormLink(type)
        && type.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;

    private static readonly HashSet<Type> P3Types = [typeof(P3Int16), typeof(P3Float)];

    private static bool IsP3Type(Type type) => P3Types.Contains(type);
}
