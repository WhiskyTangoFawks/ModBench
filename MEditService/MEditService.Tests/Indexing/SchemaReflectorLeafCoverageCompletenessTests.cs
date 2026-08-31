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

/// <summary>
/// A reflector test that walks Mutagen's own type graph for one
/// game and asserts no property of a schema-registered record type is silently dropped from the
/// reflected schema without an explicit, commented exclusion — so this class of gap (P3Int16/
/// P3Float leaves, a list nested inside a struct; before that VMAD, condition-owning fields) fails a
/// test instead of needing a manual per-record-type audit.
///
/// <para>Modeled directly on the existing sweep for a different field class,
/// <c>MEditService.Tests.Source.ContainerChildFieldsCompletenessTests</c>: independently re-derive
/// the fact under test (here, "does this property exist on the getter interface, and is it
/// represented in the schema") using Mutagen's own reflection rather than calling back into
/// <see cref="SchemaReflector"/>'s own private classification, then cross-check the two. A handful
/// of trivial one-line predicates below (<see cref="IsLoquiInterface"/>, <see cref="IsVectorStructType"/>, ...)
/// necessarily mirror <c>SchemaReflector</c>'s own — they are shape tests, not the classification
/// decision this file exists to check, the same distinction that sweep's own doc comment draws.</para>
///
/// <para><b>Deliberately depth-capped at two levels</b> — a record's own direct properties
/// (<see cref="EveryDirectRecordProperty_IsRepresentedInItsSchemaOrExplicitlyExcluded"/>), and one
/// level into any struct/array column's own element type
/// (<see cref="EveryStructOrArrayColumns_OwnDirectProperties_AreRepresentedOrExplicitlyExcluded"/>)
/// — rather than walking arbitrarily deep. Going further would mean re-deriving
/// <c>SchemaReflector</c>'s own recursive dispatch structurally in the test: a tautology (the
/// assertion recomputing the expected value the way the code does), and the two gaps that motivated
/// this sweep are both within two levels — <c>ObjectBounds</c> at depth 0 (the whole column was
/// missing), <c>Destructible.Resistances/Stages</c> at depth 1 (present column, missing sub-fields).
/// Provably not vacuous: reverting either fix in isolation reproduces a named failure here.</para>
///
/// <para><b>Scoped to shapes SchemaReflector's own dispatch vocabulary already recognizes</b>
/// (<see cref="IsRecognizedShape"/>: primitive, translated string, enum, form-link, Loqui struct,
/// P3Int16/P3Float, or a list of one of those) — not "every property of every type, however wire-
/// encoded." Without that filter the sweep also surfaces gaps of a <i>different</i> kind:
/// <c>System.Drawing.Color</c> fields (e.g. every <c>WeatherColor</c> member) and raw
/// <c>ReadOnlyMemorySlice&lt;byte&gt;</c> blobs (e.g. <c>Model.Data</c>) that
/// <c>SchemaReflector</c> has never had a case for at all, on any type. A recognized shape falling
/// through a specific crack (a P3Int16 leaf failing only for <c>ObjectBounds</c>'s two properties;
/// a struct-nested list failing only because <c>GetSubFieldInfo</c>, unlike <c>GetColumnInfo</c>,
/// lacked an <c>IsListType</c> arm) is the class this test exists to catch; an unrecognized shape
/// falling through everywhere, on every type, is a different and larger problem than this suite's
/// "leaf coverage" scope.</para>
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
    // .Name, PropertyName) at whichever depth the pair is walked.
    private static readonly HashSet<(string Owner, string Property)> KnownGaps = new()
    {
        // ── Category 2 (closed for every real abstract union): a base interface (Mutagen's
        // own "A<Name>" naming convention) whose real per-subclass data lives on concrete classes
        // that inherit *from* the abstract base — solved narrowly at first for one
        // case (OMOD's own Properties element, BuildObjectModPropertyLeafFields), then generalized
        // reflectively (SchemaReflector.BuildAbstractUnionLeafFields) for every "A<Name>" type
        // whose generated C# class is actually `abstract`.
        // CoveredAbstractUnions/CoveredNestedAbstractUnions below are the "asserted, not incidental"
        // set this mechanism covers. Two names differ from what the naming convention suggests,
        // verified against the real Mutagen source: BookTeachTarget (not
        // ABookTeachTarget) and ASoundDescriptor (not ASoundDescriptorData).
        //
        // ASceneActionType is the one "A<Name>"-named exception: its generated class
        // (ASceneActionType_Generated.cs) is `public partial class ASceneActionType`, not `public
        // abstract partial class` — confirmed against the real source, not assumed from the naming
        // convention. The mechanism keys off IsAbstract precisely so it never guesses a
        // discriminator scheme onto a type it cannot safely tell apart from an ordinary instantiable
        // one (any type the mechanism cannot faithfully model must fall
        // through to the empty sub-schema) — so this one correctly declines rather than being
        // silently mis-covered.
        //
        // The scheme (Scene.xml declares SceneAction.Type as `binary="Custom"`, so Loqui generates
        // no read/write code for it at all — it is entirely hand-written): SceneAction.cs reads the
        // ANAM subrecord as a raw UInt16 tag and switches on it directly —
        // SceneActionBinaryCreateTranslation.FillBinaryTypeCustom (mirrored by
        // SceneActionBinaryOverlay.TypeCustomParse for the lazy-overlay read path): tag 4 constructs
        // a SceneActionStartScene, every other tag (0,1,2,3,5,6 — SceneAction.TypeEnum, itself defined
        // in SceneAction.cs) constructs one shared SceneActionTypicalType with that raw tag stashed in
        // its own Type property. xEdit (wbDefinitionsFO4.pas:9032-9182, wbSceneActionTypeDecider in
        // wbDefinitionsCommon.pas:5016) reads the identical ANAM ordinal as its own union tag — the
        // two sources agree on the *discriminator*. They disagree on *shape*, and that is a modelling
        // choice, not a defect: xEdit encodes a full 7-way wbRUnion with a distinct field struct per
        // branch (Dialogue/Package/Timer/Player Dialogue/Start Scene/NPC Response Dialogue/Radio),
        // while Mutagen reaches the same data by flattening nearly all of those per-branch fields
        // (Topic, Camera, Emotion, Packages, the dialogue-response FormLinks, ...) unconditionally
        // onto SceneAction itself, leaving ASceneActionType to carry only the leftover truly
        // tag-dependent bits (the raw tag, and what the sibling HTID subrecord means — a bool marker
        // for Start Scene vs. a FormLink for everything else, handled the same custom-binary way by
        // FillBinaryHTIDParsingCustom/HTIDParsingCustomParse in the same file). So Mutagen's 2-way CLR
        // split corresponds correctly to xEdit's 7-way union; it is just not isomorphic to it.
        //
        // Two independent reasons this is not reflectively wireable, not one — fixing only the first
        // walks straight into the second:
        //   1. Structural: Scene.xml's ASceneActionType (`<Object name="ASceneActionType"
        //      objType="Subrecord" />`) deliberately omits `abstract="true"`, where Npc.xml's
        //      ANpcLevel (a genuine abstract union) has it (`<Object name="ANpcLevel" abstract="true"
        //      ...>`). That is Mutagen's own schema-authoring choice, not an oversight, so IsAbstract
        //      is the *correct* signal for this type — this is not a false negative to engineer
        //      around; there is no other reflectable marker (no schema attribute, no discriminator
        //      property on IASceneActionTypeGetter) that says "this base is only ever one of these
        //      two hand-picked leaves."
        //   2. Concrete: even a name-keyed special case bypassing IsAbstract would crash. SceneAction
        //      TypicalType's own Type property (SceneAction.TypeEnum) has no real implementation on
        //      the binary-overlay read path — SceneActionTypicalType.cs's entire override is
        //      `SceneActionTypicalTypeBinaryOverlay.Type => throw new NotImplementedException();`,
        //      and the generated overlay class (SceneActionTypicalType_Generated.cs) implements it no
        //      other way. DefaultModImporter/LoadOrder/LoadOrderMirror all read plugins through
        //      ModFactory.ImportGetter, which Mutagen.Bethesda.Core/Plugins/Records/ModFactory.cs
        //      resolves via CreateFromBinaryOverlay — the exact lazy-overlay path that throws. Wiring
        //      SceneActionTypicalType.Type in would crash indexing the first time it reached any real
        //      FO4 plugin's Scene record carrying a non-Start-Scene action (tag 0, 1, 2, 3, 5, or 6) —
        //      a live defect, not a hypothetical, and one this census test (type-level only) would
        //      never catch on its own.
        //
        // Contingent, not permanent: if Mutagen ever implements that overlay getter for real and
        // marks ASceneActionType abstract in Scene.xml (bringing it in line with ANpcLevel/
        // AQuestAlias), both blockers lift together and the existing mechanism would cover this
        // type with no extension needed — "cannot yet", not "cannot". Until then, KnownGaps stays.
        // Condition/ConditionData and AVirtualMachineAdapter (VMAD) are
        // ALSO genuinely `abstract`, structurally identical to ANpcLevel/AQuestAlias — the
        // mechanism's own IsAbstract gate would cover them the same way. It doesn't:
        // SchemaReflector.AbstractUnionExcludedTypeNames names both explicitly, because they are
        // permanently outside the reflected schema by documented architectural boundary
        // (MEditService/CLAUDE.md:232-235), not because the mechanism can't model them. Not this
        // file's own exclusion list either — nothing here would ever surface a Condition/VMAD field
        // as a gap to begin with (BaseSkip/IsConditionListField/vmadInterfaceType already keep them
        // off the depth-0 walk this file does), so there is nothing to name in KnownGaps for them.
        ("ISceneActionGetter", "Type"),            // ASceneActionType — deliberately not abstract; see above

        // ── Category 3: a real, non-abstract Loqui struct whose only members are themselves an
        // unrecognized shape — a raw byte blob, not a Noggog vector struct.
        // ScenePhaseUnusedData appears on both Scene's own phase
        // data and SceneAction; the same reason both are named.
        ("ISceneGetter", "Unused"),                // ScenePhaseUnusedData
        ("ISceneGetter", "Unused2"),               // ScenePhaseUnusedData
        ("ISceneActionGetter", "Unused"),          // ScenePhaseUnusedData

        // ── Category 4: not a reflector gap at all — a false positive of this test's own simplistic
        // column-name matching against the sibling-shape merge. DamageType and its sibling
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

    // Every (Owner, Property) pair the general abstract-union mechanism covers — named here
    // rather than left as an incidental byproduct of removing most of Category 2 above
    // (a byproduct type quietly changing shape would otherwise go unnoticed).
    // The two mandatory types (ANpcLevel, AQuestAlias) plus every other real abstract union (its
    // generated C# class actually `abstract` — see ASceneActionType's own Category 2 comment for the
    // one "A<Name>"-named exception that is not), verified by reading the real generated Mutagen
    // source rather than assumed to share the same structural shape: an abstract base backed by an
    // ordinary non-generic Setter class, one or more concrete baseClass="X" subclasses in the same
    // assembly, no cross-leaf same-name shape disagreement. ANavmeshParent/ALocationTarget's own
    // leaves mix a FormLink with a P2Int16/scalar — BuildSubField's own already-recognized shapes,
    // not a new one; APerkEffect/APerkEntryPointEffect's two-level baseClass chain resolves the same
    // way IsAssignableFrom always does, transitively, with no depth-specific code needed.
    //
    // Owner is a schema-registered RecordType's own getter interface name for the first list — these
    // are checked directly off GetSchemas. NavmeshGeometry and LocationTargetRadius are common
    // subrecords embedded inside several *other* record types (Activator/Furniture/Static's own
    // NavmeshGeometry; Faction's own VendorLocation) rather than schema-registered record types of
    // their own, so they are checked the second, nested way instead — one level inside whichever
    // record's own column reaches them, the same walk EveryStructOrArrayColumns_... already does.
    private static readonly (string Owner, string Property)[] CoveredAbstractUnions =
    [
        ("INpcGetter", "Level"),                    // ANpcLevel: NpcLevel / PcLevelMult — mandatory
        ("IQuestGetter", "Aliases"),                 // AQuestAlias: QuestReferenceAlias / QuestLocationAlias / QuestCollectionAlias — mandatory
        ("IBookGetter", "Teaches"),                  // BookTeachTarget
        ("IColorRecordGetter", "Data"),              // AColorRecordData
        ("IHolotapeGetter", "Data"),                 // AHolotapeData
        ("ISoundDescriptorGetter", "Data"),          // ASoundDescriptor
        ("IPerkGetter", "Effects"),                  // APerkEffect / APerkEntryPointEffect (two-level chain)
        // The census's own re-run turned these two up as also-covered —
        // named here rather than left invisible.
        ("IMagicEffectGetter", "Archetype"),         // AMagicEffectArchetype
        ("IAudioEffectChainGetter", "Effects"),      // AAudioEffect
    ];

    private static readonly (string Owner, string Property)[] CoveredNestedAbstractUnions =
    [
        ("INavmeshGeometryGetter", "Parent"),        // ANavmeshParent
        ("ILocationTargetRadiusGetter", "Target"),   // ALocationTarget
    ];

    [Fact]
    public void EveryCoveredAbstractUnion_ExposesNonEmptySubSchemaWithConcreteTypeDiscriminator()
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
                    var match = nestedFields.SingleOrDefault(f => f.Name == SchemaReflector.ToSnakeCase(property));
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
            if (fields.All(f => f.Name != "concrete_type"))
                regressed.Add($"{label} (no concrete_type discriminator)");
        }
    }

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
                if (ownerProp == null) continue; // not this schema's own property (e.g. sibling-shape merge) — depth-0 test covers it on its own type
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
    // Noggog's small value-vector structs (see IsVectorStructType) are special-cased to exactly
    // X/Y/Z rather than a generic property walk, mirroring
    // SchemaReflector.BuildVectorComponentSubFields' own explicit scope: every one of these types
    // carries real geometry-helper properties (Length, Magnitude, SqrMagnitude, Normalized,
    // Absolute) that are computed, not serialized data, and several (P3Int16, P2UInt8, P3UInt8,
    // P3UInt16) have their own self-referencing Point (`P3Int16 Point => this`) — "all public
    // properties" is the wrong model of "this type's own data" for any of them, the same reason
    // BuildVectorComponentSubFields itself is a fixed name list rather than a property walk.
    // A 2-component type (P2Int, P2UInt8, P2Int16, P2Float) has no "Z" — GetProperty returns null
    // for it, which the null filter below drops rather than crashing on `.Name` downstream, mirroring
    // BuildVectorComponentSubFields' own `if (componentProp == null) continue`.
    private static IEnumerable<PropertyInfo> DirectDataProperties(Type type, HashSet<string> skip)
    {
        if (IsVectorStructType(type))
        {
            return new[] { "X", "Y", "Z" }
                .Select(n => type.GetProperty(n, BindingFlags.Public | BindingFlags.Instance))
                .Where(p => p != null)!;
        }

        return type.GetInterfaces().Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            .Where(p => !skip.Contains(p.Name) && IsRecognizedShape(p.PropertyType))
            .GroupBy(p => p.Name, StringComparer.Ordinal)
            .Select(g => g.First());
    }

    // A property's own nested getter type, one level in — a Loqui struct, a Noggog vector struct, or
    // (for a list column) whichever of those its element type is. Null for a plain scalar/enum/
    // FormLink/translated-string leaf and for a list of one of those: nothing to walk further into.
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

    // Mirrors SchemaReflector.VectorStructTypes — every Noggog small value-vector struct actually
    // reachable in FO4's schema graph (verified by grepping
    // references/Mutagen/Mutagen.Bethesda.Fallout4, not assumed):
    // P2Int (Cell.Grid.Point), P2UInt8 (WorldDefaultLevelData), P2Int16 (WorldspaceMaxHeight and
    // others, including as a list element on LocationCoordinate.Coordinates), P3UInt8
    // (LandscapeVertexHeightMap.Unknown), P3UInt16 (RegionObject.AngleVariance), P2Float
    // (ImageSpaceAdapter.RadialBlurCenter). Noggog's other siblings (P2Double, P3Double, P3Int, the
    // *Value*/*Obj wrapper types) have zero usages anywhere in FO4's record graph, so they stay out.
    private static readonly HashSet<Type> VectorStructTypes =
    [
        typeof(P3Int16), typeof(P3Float),
        typeof(P2Int), typeof(P2UInt8), typeof(P2Int16),
        typeof(P3UInt8), typeof(P3UInt16), typeof(P2Float),
    ];

    private static bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type);
}
