using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Schema;

public sealed partial class SchemaReflector(ILogger<SchemaReflector>? logger = null) : ISchemaReflector
{
    // Stryker disable once NullCoalescing: logger init; only usage is a defensive LogTrace in catch — unreachable from tests without artificial exception injection
    private readonly ILogger _logger = logger ?? NullLogger<SchemaReflector>.Instance;

    // Issue #110: these two sets were one undifferentiated list, mixing two unrelated rules.
    // Split so each is documented on its own terms; `pfo2` (formerly in this list) was dead —
    // it's a PACK sub-record struct field (wbStruct(PFO2, 'Data', ...) in wbDefinitionsFO4.pas),
    // never a top-level Mutagen record type, so it could never have been discovered here anyway.

    // Deliberate product filter: not standard editable refs (Phase 16 placed refr/achr are
    // indexed as normal records so the worldspace tree, record editor, and agent queries are
    // uniform DuckDB reads; their cell parentage lives in the `placement` side table — land/
    // navm/navi don't get that treatment).
    private static readonly HashSet<string> NonEditableRefTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "land", "navm", "navi",
    };

    // xEdit-signature-variant collapsing: rare REFR-flavor placement types (projectile/hazard/
    // etc. placements) that mEdit doesn't surface as distinct record types.
    private static readonly HashSet<string> XEditRefSignatureVariants = new(StringComparer.OrdinalIgnoreCase)
    {
        "pgre", "pmis", "parw", "pbar", "pbea", "pcon", "pfla", "phzd",
    };

    private static readonly HashSet<string> ExcludedTables =
        new(NonEditableRefTypes.Concat(XEditRefSignatureVariants), StringComparer.OrdinalIgnoreCase);

    private sealed record GameSchemaCache(
        IReadOnlyDictionary<string, RecordTableSchema> Schemas,
        IReadOnlyDictionary<Type, string> GetterTypeToTable);

    private readonly ConcurrentDictionary<GameCategory, GameSchemaCache> _cache = new();

    public IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release) =>
        GetCache(release.ToCategory()).Schemas;

    private GameSchemaCache GetCache(GameCategory category) =>
        _cache.GetOrAdd(category, c => BuildForCategory(c, _logger));

    private static GameSchemaCache BuildForCategory(GameCategory category, ILogger logger)
    {
        var assemblyName = $"Mutagen.Bethesda.{category}";
        var assembly = AppDomain.CurrentDomain.GetAssemblies()
                           .FirstOrDefault(a => a.GetName().Name == assemblyName)
                       ?? Assembly.Load(assemblyName);

        var majorRecordGetterType =
            assembly.GetType($"Mutagen.Bethesda.{category}.I{category}MajorRecordGetter")!;

        // #263: a GRUP signature can be backed by several concrete Mutagen subclasses sharing one
        // abstract base — GameSettingInt/Float/String/Bool/UInt are all GMST, GlobalInt/Float/
        // Short/Bool are all GLOB, DamageType/DamageTypeIndexed are both DMGT — because the type
        // discriminant lives on the record itself (an EditorID prefix, a subrecord, ...), never on
        // the table. `discovered`/`seenTables` still record one winner per table (RecordType and
        // the lifecycle delegates below stay bound to it, deliberately unchanged by this fix — see
        // BuildLifecycleDelegates and BuildSchema), but `siblingsByTable` keeps every concrete type
        // sharing a signature so BuildSchema can union their columns instead of the loser's shape
        // being silently dropped (issue #263: that drop is why a GameSetting's Data column only
        // ever worked for whichever subclass reflection happened to enumerate first).
        var seenTables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var discovered = new List<(string tableName, Type getterType)>();
        var siblingsByTable = new Dictionary<string, List<Type>>(StringComparer.OrdinalIgnoreCase);

        foreach (var type in assembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface) continue;
            if (!majorRecordGetterType.IsAssignableFrom(type)) continue;

            var grupField = type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static);
            if (grupField == null) continue;

            var recordType = (RecordType)grupField.GetValue(null)!;
            var tableName = recordType.Type.ToLowerInvariant();

            if (ExcludedTables.Contains(tableName)) continue;

            var getterInterface = assembly.GetType($"Mutagen.Bethesda.{category}.I{type.Name}Getter")!;

            if (!siblingsByTable.TryGetValue(tableName, out var siblings))
                siblingsByTable[tableName] = siblings = [];
            siblings.Add(getterInterface);

            if (!seenTables.Add(tableName)) continue;

            discovered.Add((tableName, getterInterface));
        }

        // Bundled fix (issue #263): every sibling getter type now resolves to its table, not just
        // the winner — before this, a FormLink<IGameSettingFloatGetter> anywhere in the schema
        // failed to resolve ValidFormKeyTypes to ["gmst"] whenever Float wasn't that run's winner
        // (GetFormLinkValidTypes below looks types up in this same dictionary).
        var getterTypeToTable = siblingsByTable
            .SelectMany(kv => kv.Value.Select(t => (Type: t, Table: kv.Key)))
            .ToDictionary(x => x.Type, x => x.Table);

        var modType = assembly.GetType($"Mutagen.Bethesda.{category}.{category}Mod");

        // #178: resolved once per category (condition codecs are stateless per-call factories,
        // and the codec itself doesn't vary per table) — passed into BuildSchema so it can skip
        // condition-shaped properties the same way baseSkip skips other fields, keeping the
        // Conditions section (Fallout4ConditionCodec.Extract) as the one place they're surfaced.
        var conditionCodec = ConditionCodecRegistry.For(category);

        // #179: resolved once per category, game-neutral like everything else here — each game
        // assembly declares its own IHaveVirtualMachineAdapterGetter in its flat
        // Mutagen.Bethesda.{category} namespace (no shared cross-game interface exists), the same
        // one Records/DuckDbRecordRepository.IndexVmad keys off for a given game's compiled type.
        // Null (a hypothetical future game without the concept) means no table in that category
        // can ever carry VMAD.
        var vmadInterfaceType = assembly.GetType($"Mutagen.Bethesda.{category}.IHaveVirtualMachineAdapterGetter");

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            var schema = BuildSchema(
                tableName, getterType, siblingsByTable[tableName],
                getterTypeToTable, logger, conditionCodec, vmadInterfaceType);
            var (addNew, remove, addExisting) = BuildLifecycleDelegates(modType, getterType);

            schemas[tableName] = addNew == null ? schema : new RecordTableSchema
            {
                TableName = schema.TableName,
                DisplayName = schema.DisplayName,
                RecordType = schema.RecordType,
                RecordColumns = schema.RecordColumns,
                HasVmad = schema.HasVmad,
                AddNew = addNew,
                Remove = remove,
                AddExisting = addExisting,
            };
        }

        AddHeaderSchemaIfAvailable(schemas, category, assembly, getterTypeToTable, logger);

        return new GameSchemaCache(schemas, getterTypeToTable);
    }

    private static void AddHeaderSchemaIfAvailable(
        Dictionary<string, RecordTableSchema> schemas, GameCategory category, Assembly assembly,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        if (BuildHeaderSchema(category, assembly, getterTypeToTable, logger) is { } headerSchema)
            schemas["header"] = headerSchema;
    }

    // ── Header schema (Issue #1 slice A1) ──────────────────────────────────────
    // A mod header is not a major record in Mutagen (no FormKey/EditorID) — it can't be
    // discovered by the major-record-getter scan above, so it gets one hand-assembled schema
    // entry instead. Author/Flags come from a second small reflection pass over the per-game
    // ModHeader getter type (I{category}ModGetter.ModHeader), reusing the same leaf-classification
    // helpers used everywhere else; Masters comes straight off the game-agnostic IModGetter — no
    // reflection needed, since MasterReferences is already exposed generically.
    //
    // ColumnSpec.Extract is unused here (it's Func<IMajorRecordGetter, object?>; a header is never
    // one, and the header table bypasses the major-record indexing loop entirely) — the real
    // per-plugin extraction is HeaderColumnExtract, positionally aligned with RecordColumns.
    private static RecordTableSchema? BuildHeaderSchema(
        GameCategory category, Assembly assembly,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var modGetterType = assembly.GetType($"Mutagen.Bethesda.{category}.I{category}ModGetter");
        var modHeaderProp = modGetterType?.GetProperty("ModHeader", BindingFlags.Public | BindingFlags.Instance);
        if (modHeaderProp == null)
        {
            logger.LogWarning("No ModHeader property found for {Category}; header record unavailable", category);
            return null;
        }

        var headerGetterType = modHeaderProp.PropertyType;
        var columns = new List<ColumnSpec>();
        var extracts = new List<Func<IModGetter, object?>>();
        var applies = new List<Action<IMod, JsonElement>?>();
        long? eslFlagValue = null;

        var authorProp = headerGetterType.GetProperty("Author", BindingFlags.Public | BindingFlags.Instance);
        if (authorProp != null && ClassifyLeaf(authorProp, authorProp.PropertyType, getterTypeToTable) is { } authorLeaf)
        {
            columns.Add(new ColumnSpec("author", authorProp.Name, authorLeaf.DuckDbType, _ => null,
                authorLeaf.ApiType, authorLeaf.ValidFormKeyTypes, authorLeaf.EnumValues, Apply: null));
            extracts.Add(HeaderPropertyExtract(modHeaderProp, authorLeaf.Get));
            applies.Add(HeaderPropertyApply(modHeaderProp, authorProp.Name, nullable: true, authorLeaf.Convert));
        }
        else
        {
            logger.LogWarning("No Author property found on {HeaderType}; header author column omitted", headerGetterType);
        }

        var flagsProp = headerGetterType.GetProperty("Flags", BindingFlags.Public | BindingFlags.Instance);
        if (flagsProp?.PropertyType.IsEnum == true)
        {
            var flagsLeaf = ClassifyEnumLeaf(flagsProp, flagsProp.PropertyType);
            // EslFlagValue detection runs off the raw Mutagen member names before the xEdit
            // display-name rename below — LightMasterFlagNames is the source of truth for "which
            // member means ESL", independent of what the UI displays.
            eslFlagValue = FindEslFlagValue(flagsLeaf.EnumValues, flagsLeaf.EnumBitValues);

            // Issue #118: only the header's flags column gets xEdit's display names — every other
            // bitmask enum in the schema (npc_, race, ...) keeps its raw Mutagen member names, so
            // this maps flagsLeaf.EnumValues here rather than inside ClassifyEnumLeaf.
            var displayNames = flagsLeaf.EnumValues.Select(MapToXEditFlagName).ToArray();
            columns.Add(new ColumnSpec("flags", flagsProp.Name, flagsLeaf.DuckDbType, _ => null,
                flagsLeaf.ApiType, flagsLeaf.ValidFormKeyTypes, displayNames, Apply: null,
                IsBitmask: flagsLeaf.IsBitmask, EnumBitValues: flagsLeaf.EnumBitValues));
            extracts.Add(HeaderPropertyExtract(modHeaderProp, flagsLeaf.Get));
            applies.Add(HeaderPropertyApply(modHeaderProp, flagsProp.Name, nullable: false, flagsLeaf.Convert));
        }
        else
        {
            logger.LogWarning("No Flags enum property found on {HeaderType}; header flags column omitted", headerGetterType);
        }

        var mastersElement = new FieldMetadata("", "string", false, Empty, Empty);
        columns.Add(new ColumnSpec(HeaderIndexer.MastersFieldName, "MasterReferences", "VARCHAR", _ => null, "array",
            Empty, Empty, Apply: null, IsArray: true, ElementType: mastersElement));
        extracts.Add(mod => JsonSerializer.Serialize(mod.MasterReferences.Select(r => r.Master.FileName.ToString()).ToList()));
        applies.Add(HeaderMastersApply()); // Issue #86: add-only master list; validation is the caller's

        return new RecordTableSchema
        {
            TableName = "header",
            DisplayName = RecordDisplayNames.For("header"),
            RecordType = headerGetterType,
            RecordColumns = columns,
            HeaderColumnExtract = extracts,
            HeaderColumnApply = applies,
            EslFlagValue = eslFlagValue,
            HasVmad = false, // a mod header is never a major record; VMAD is structurally not a concept here
        };
    }

    // Write counterpart to the masters extract: MasterReferences lives directly on IMod (not under
    // ModHeader, unlike author/flags), so this doesn't go through HeaderPropertyApply's
    // modHeaderProp.GetValue indirection — it rebuilds mod.MasterReferences in place from the
    // incoming JSON array of plugin filenames. Validating that array is the caller's job
    // (issue #86) — this apply trusts whatever it is handed.
    private static Action<IMod, JsonElement> HeaderMastersApply() => (mod, json) =>
    {
        if (json.ValueKind != JsonValueKind.Array) return;
        var list = mod.MasterReferences;
        list.Clear();
        foreach (var el in json.EnumerateArray())
        {
            if (el.GetString() is not string name) continue;
            list.Add(new MasterReference { Master = ModKey.FromFileName(name) });
        }
    };

    private static Func<IModGetter, object?> HeaderPropertyExtract(PropertyInfo modHeaderProp, Func<object, object?> leafGet) =>
        mod => modHeaderProp.GetValue(mod) is { } header ? leafGet(header) : null;

    // Write counterpart to HeaderPropertyExtract: resolves the mutable ModHeader off the setter mod
    // and applies the converted JSON onto its property (reusing MakeApplier's by-name set + null
    // handling). Convert is never null for the header's author/flags leaves (primitive / enum).
    private static Action<IMod, JsonElement>? HeaderPropertyApply(
        PropertyInfo modHeaderProp, string propName, bool nullable, Func<JsonElement, object?>? convert)
    {
        if (convert == null) return null;
        var applier = MakeApplier(propName, nullable, convert);
        return (mod, json) => { if (modHeaderProp.GetValue(mod) is { } header) applier(header, json); };
    }

    // Member names Mutagen uses for the light-master ("ESL") flag across games.
    private static readonly HashSet<string> LightMasterFlagNames =
        new(StringComparer.OrdinalIgnoreCase) { "Small", "LightMaster", "Light" };

    // Issue #118: xEdit's display names for the plugin header's flags, keyed off the Mutagen
    // member name (never a bit position — bit positions differ across games; see
    // wbDefinitionsFO4.pas for the source vocabulary: ESM/Localized/ESL/Update). Applies only to
    // the header's flags column (see BuildHeaderSchema); every other bitmask enum in the schema
    // keeps its raw Mutagen member names. Optimized/Localized/Update already match xEdit's own
    // spelling, so they need no entry here; a member with no xEdit counterpart at all (e.g.
    // Overlay, Medium) falls through unchanged too.
    internal static string MapToXEditFlagName(string mutagenName)
    {
        if (mutagenName.Equals("Master", StringComparison.OrdinalIgnoreCase)) return "ESM";
        return LightMasterFlagNames.Contains(mutagenName) ? "ESL" : mutagenName;
    }

    // names and bitValues are the parallel arrays ClassifyEnumLeaf builds in lockstep (a bitmask
    // enum always yields both), so a single bound over names indexes bitValues safely.
    private static long? FindEslFlagValue(string[] names, string[]? bitValues)
    {
        if (bitValues == null) return null;
        for (int i = 0; i < names.Length; i++)
        {
            if (LightMasterFlagNames.Contains(names[i]))
                return long.Parse(bitValues[i], System.Globalization.CultureInfo.InvariantCulture);
        }
        return null;
    }

    // Builds the record-lifecycle delegates bound to the mod's typed group for this record
    // type. Every delegate is null when the group or a mutable setter type cannot be resolved.
    private static (Action<IMod, FormKey>? AddNew, Func<IMod, FormKey, bool>? Remove, Action<IMod, IMajorRecord>? AddExisting)
        BuildLifecycleDelegates(Type? modType, Type getterType)
    {
        if (modType == null) return default;

        var setterType = GetSetterType(getterType);
        if (setterType == null) return default;

        var targetGroupType = typeof(IGroup<>).MakeGenericType(setterType);
        var groupProp = modType
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(p => targetGroupType.IsAssignableFrom(p.PropertyType));
        if (groupProp == null) return default;

        void AddNewToGroup(IMod mod, FormKey fk)
        {
            var group = (IGroup)groupProp.GetValue(mod)!;
            group.AddNew(fk);
        }
        void AddExistingToGroup(IMod mod, IMajorRecord rec)
        {
            var group = (IGroup)groupProp.GetValue(mod)!;
            group.AddUntyped(rec);
        }

        // Remove(FormKey) is on IGroup<T>, not the non-generic IGroup; resolve MethodInfo
        // once at schema-build time and close over it to avoid per-call reflection.
        Func<IMod, FormKey, bool>? remove = null;
        var removeMethod = targetGroupType
            .GetMethod("Remove", BindingFlags.Public | BindingFlags.Instance, [typeof(FormKey)]);
        if (removeMethod != null)
        {
            remove = (mod, fk) =>
            {
                var grp = groupProp.GetValue(mod)!;
                return removeMethod.Invoke(grp, [fk]) is true;
            };
        }

        return (AddNewToGroup, remove, AddExistingToGroup);
    }

    private static readonly HashSet<string> BaseSkip = new(StringComparer.OrdinalIgnoreCase)
    {
        "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl",
        "MajorRecordFlagsRaw", "SubgraphRevision"
    };

    // #263: RecordType (used for enumeration in DuckDbRecordRepository.IndexRecordTable) and the
    // lifecycle delegates (AddNew/Remove/AddExisting, built from getterType just below) stay bound
    // to the discovery winner, deliberately, even though RecordColumns below is unioned across
    // every sibling. Two independent reasons:
    //   - Enumeration already returns every sibling's records no matter which one's getter
    //     interface is named — Mutagen's own EnumerateMajorRecords falls back through
    //     InheritingInterfaceMapping to the abstract group base (e.g. IGameSettingGetter) and the
    //     group enumerator returns every element once the requested type is assignable to it. Rows
    //     were never dropped; only the Data column's extraction was broken. So RecordType has
    //     nothing to gain from pointing at the abstract base.
    //   - GetSetterType(getterType) resolves the *instantiable* class AddNew/AddExisting need
    //     (via ILoquiRegistration.SetterType). Pointing it at an abstract base's getter interface
    //     resolves to the abstract class itself, and IGroup.AddNew(FormKey) needs something
    //     constructible — that would turn "add a new GMST record" from quietly-wrong-but-working
    //     (today it always creates whichever concrete subclass happens to be the winner) into a
    //     hard throw. Record *creation* is unrelated to this ticket's display defect and is left
    //     exactly as good (or bad) as it already was.
    private static RecordTableSchema BuildSchema(
        string tableName, Type getterType, List<Type> siblingGetterTypes,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger,
        IConditionCodec? conditionCodec, Type? vmadInterfaceType)
    {
        var columns = ReflectColumns(getterType, conditionCodec, vmadInterfaceType, getterTypeToTable, logger);

        // #263: union in every other concrete subclass sharing this signature (siblingGetterTypes
        // is just [getterType] for the overwhelming majority of tables, so this loop is a no-op
        // there). The rule is expressed purely in terms of a column's *shape*, never a table or
        // signature name, so a hypothetical third subclass of an existing signature — or a
        // brand-new game's own multi-subclass signature — is handled the same way with no code
        // change here. See MergeSiblingColumn for the shape rule itself.
        if (siblingGetterTypes.Count > 1)
        {
            var widenedDispatch = new Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>>();
            var nonScalarMergeDispatch = new Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>>();
            foreach (var sibling in siblingGetterTypes)
            {
                if (sibling == getterType) continue;
                var siblingColumns = ReflectColumns(sibling, conditionCodec, vmadInterfaceType, getterTypeToTable, logger);
                foreach (var siblingSpec in siblingColumns)
                    MergeSiblingColumn(columns, widenedDispatch, nonScalarMergeDispatch, getterType, sibling, siblingSpec);
            }
        }

        return new RecordTableSchema
        {
            TableName = tableName,
            DisplayName = RecordDisplayNames.For(tableName),
            RecordType = getterType,
            RecordColumns = columns,
            HasVmad = vmadInterfaceType?.IsAssignableFrom(getterType) ?? false,
        };
    }

    // #178: condition-shaped properties (e.g. Perk.Conditions, Quest.DialogConditions/
    // UnusedConditions) are already surfaced by the game's IConditionCodec into the record
    // editor's dedicated Conditions section — reflecting them again here would duplicate
    // them as plain array columns. Game-generic: the shape test lives behind the codec
    // (IsConditionListField), not a hardcoded field-name list, so a game with no registered
    // codec (conditionCodec == null) simply skips no extra fields here.
    //
    // #260: same rule for the virtual-machine-adapter property — it's already surfaced by
    // the dedicated Scripts (VMAD) section (HasVmad, set in BuildSchema above since #263 split
    // this filtering out into its own ReflectColumns; RecordQueryService.GetVmad), so
    // reflecting it again here would duplicate it as an opaque struct column. Type-scoped to
    // match the section it defers to: HasVmad only renders for a getterType the interface is
    // assignable to, so the exclusion only fires there too — a type that doesn't implement
    // the interface must lose nothing. No hardcoded property name: the property is whatever
    // vmadInterfaceType itself declares, so a game category with no such interface
    // (vmadInterfaceType == null) skips nothing.
    //
    // #263: extracted so BuildSchema can call it once per sibling getter type sharing a signature,
    // not just the discovery winner — identical logic and output to what BuildSchema used to do
    // inline for a single getterType.
    private static List<ColumnSpec> ReflectColumns(
        Type getterType, IConditionCodec? conditionCodec, Type? vmadInterfaceType,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var grouped = GetAllInterfaceProperties(getterType)
            .Where(p => !BaseSkip.Contains(p.Name))
            .Where(p => conditionCodec == null || !conditionCodec.IsConditionListField(getterType, p.Name))
            .Where(p => vmadInterfaceType == null
                        || !vmadInterfaceType.IsAssignableFrom(getterType)
                        || vmadInterfaceType.GetProperty(p.Name) == null)
            .GroupBy(p => ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase);

        var columns = new List<ColumnSpec>();

        foreach (var group in grouped)
        {
            var colName = group.Key;

            var prop = group.Aggregate((best, candidate) =>
                best.DeclaringType!.IsAssignableFrom(candidate.DeclaringType!) ? candidate : best);

            var info = GetColumnInfo(prop, getterTypeToTable, logger);
            if (info == null) continue;

            columns.Add(new ColumnSpec(
                colName, prop.Name, info.DuckDbType, info.Extractor, info.ApiType,
                info.ValidFormKeyTypes, info.EnumValues, info.Apply,
                IsArray: info.ApiType == "array",
                ElementType: info.ElementMeta,
                SubFields: info.SubFieldMetas,
                AllowsNull: info.AllowsNull,
                IsBitmask: info.IsBitmask,
                EnumBitValues: info.EnumBitValues));
        }

        return columns;
    }

    // A column's ApiType that means "not a single scalar value" — reflection produces these two
    // (BuildListColumn / BuildStructColumn); everything else GetColumnInfo can return is scalar.
    private static readonly HashSet<string> NonScalarApiTypes = new(StringComparer.Ordinal) { "array", "struct" };

    // #339: distinguishes OMOD's Properties (mergeable — every sibling's element is the same
    // struct{property: enum, step: float}, only the enum's own member-name domain differs per
    // sibling) from DMGT's DamageTypes (not mergeable — DamageType's element is a struct of two
    // formlinks, DamageTypeIndexed's is a bare uint, no field names in common at all). Two enum
    // leaves are always considered compatible here — their domains get unioned by the caller, not
    // by this check — everything else (Type, IsArray, AllowsNull, IsBitmask, and recursively
    // Fields/ElementType) must match exactly, including field *presence*: a name only one side
    // declares is a real conflict, not something a domain union can paper over.
    private static bool IsSameShapeExceptEnumDomain(FieldMetadata? a, FieldMetadata? b)
    {
        if (a == null || b == null) return a == b;
        if (a.Type != b.Type || a.IsArray != b.IsArray || a.AllowsNull != b.AllowsNull || a.IsBitmask != b.IsBitmask)
            return false;
        if (a.Type == "enum") return true;

        if (a.Fields == null != (b.Fields == null)) return false;
        if (a.Fields != null && b.Fields != null)
        {
            if (a.Fields.Count != b.Fields.Count) return false;
            foreach (var fa in a.Fields)
            {
                var fb = b.Fields.FirstOrDefault(f => f.Name == fa.Name);
                if (fb == null || !IsSameShapeExceptEnumDomain(fa, fb)) return false;
            }
        }

        return IsSameShapeExceptEnumDomain(a.ElementType, b.ElementType);
    }

    // IsSameShapeExceptEnumDomain applied to two columns, with the *column's own* AllowsNull
    // normalized away first. That flag is bookkeeping this ladder itself introduces (a column
    // becomes AllowsNull once it's dispatch-guarded — MergeNonScalarByEnumDomain,
    // SplitNonScalarByShape), not a property of the underlying Mutagen shape — comparing it here
    // would make the routing decision depend on whether this column happened to be merged already,
    // not on whether the sibling's shape actually matches. A freshly-reflected sibling spec is
    // never itself AllowsNull for this reason, so leaving the raw comparison in would falsely
    // report a shape mismatch for a real match the moment a column had already merged once.
    private static bool IsSameColumnShapeExceptEnumDomain(ColumnSpec a, ColumnSpec b) =>
        IsSameShapeExceptEnumDomain(
            a.ToFieldMetadata() with { AllowsNull = false },
            b.ToFieldMetadata() with { AllowsNull = false });

    // #263: folds one sibling's version of a column into the accumulating union. The rule is
    // shape-based, never keyed by table or signature name — see BuildSchema's caller comment for
    // why that matters (AC: a hypothetical third subclass, or another game's own signature, must
    // be handled with no code change here).
    //
    //   - not present yet on any sibling seen so far: add it as-is, but nullable — not every
    //     sibling declares it. Real today, not hypothetical: GlobalFloat.OutputChar (confirmed
    //     against Global.xml) is declared only on IGlobalFloatGetter — GlobalInt/Short/Bool have
    //     nothing under that name — so it's exactly this branch, load-bearing right now, not a
    //     shape kept only for a future third subclass.
    //   - present already, identical shape (same DuckDbType + ApiType): leave it. This is the
    //     common case — a member declared on the shared abstract base (EditorID, Unknown, MaxRank,
    //     ...) is already reachable, and reads correctly, off *every* sibling instance via ordinary
    //     interface dispatch, because the reflected PropertyInfo comes from an interface every
    //     sibling implements, not from one sibling's own interface.
    //   - present already, conflicting SCALAR shape (GMST/GLOB's per-subclass Data: Int32?/Single?/
    //     TranslatedString?/Boolean?/UInt32?): widen to a read-only text column whose Extract
    //     resolves the record's actual sibling at read time and only ever invokes *that* sibling's
    //     own PropertyInfo — never a foreign one, which is what made the original bug's silent
    //     try/catch swallow every non-winning subclass's value to null.
    //   - present already, conflicting NON-scalar shape, structurally identical except which enum
    //     member names the shared "which property" leaf allows (OMOD's Properties — every sibling's
    //     element is struct{property: enum, step: float}, only the enum's own domain differs):
    //     merge into one column, keeping the typed shape and dispatching Extract to whichever
    //     sibling's own (already-correct) reflected Extract matches the record's runtime type —
    //     never a foreign one. See MergeNonScalarByEnumDomain.
    //   - present already, conflicting NON-scalar shape, structurally different (DMGT's
    //     DamageTypes — DamageType's element is a struct of two formlinks, DamageTypeIndexed's is a
    //     bare uint, no field names in common): split into two columns, one per shape, each
    //     dispatch-guarded to its own declaring sibling(s) by construction rather than a swallowed
    //     throw. See SplitNonScalarByShape.
    private static void MergeSiblingColumn(
        List<ColumnSpec> columns,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> widenedDispatch,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> nonScalarMergeDispatch,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existingIndex = columns.FindIndex(c => c.Name == siblingSpec.Name);
        if (existingIndex < 0)
        {
            columns.Add(siblingSpec with { AllowsNull = true });
            return;
        }

        var existing = columns[existingIndex];

        if (widenedDispatch.TryGetValue(existing.Name, out var dispatch))
        {
            // Already widened by an earlier conflicting sibling for this table — extend the same
            // dispatch list rather than re-deriving it (a fifth sibling, as GMST's Data has, must
            // still only ever read its own PropertyInfo).
            dispatch.Add((siblingGetterType, siblingSpec.Extract));
            return;
        }

        if (nonScalarMergeDispatch.ContainsKey(existing.Name))
        {
            // Already merged by an earlier conflicting sibling. Nothing guarantees a later sibling
            // sharing this column's *name* also shares the shape the earlier ones merged on — this
            // must re-check, not assume: BuildForCategory is game-generic (any Mutagen.Bethesda.
            // {category}), so a genuinely mismatched third-plus sibling here is not an FO4-only
            // hypothetical, and skipping this check let UnionEnumDomains' by-name Fields lookup
            // throw uncaught, taking out schema construction for the whole category.
            if (IsSameColumnShapeExceptEnumDomain(existing, siblingSpec))
            {
                // Extend the same dispatch list AND fold this sibling's own enum domain into the
                // running union (a fifth OMOD-shaped sibling must still contribute its own T's
                // member names, not just the second one).
                MergeNonScalarByEnumDomain(
                    columns, existingIndex, nonScalarMergeDispatch, winnerGetterType, siblingGetterType, siblingSpec);
                return;
            }

            // Genuinely mismatched. `existing` is already a merged, multi-sibling-safe column —
            // its Extract dispatches correctly across every sibling folded into it so far — so this
            // never touches it; retroactively re-splitting an already-merged group is speculative
            // machinery for a conflict no supported game currently has (same trade-off
            // SplitNonScalarByShape itself declines below). The mismatched sibling gets its own
            // column instead of being silently dropped.
            AddAsOwnColumn(columns, siblingGetterType, siblingSpec);
            return;
        }

        if (NonScalarApiTypes.Contains(existing.ApiType) || NonScalarApiTypes.Contains(siblingSpec.ApiType))
        {
            if (IsSameColumnShapeExceptEnumDomain(existing, siblingSpec))
            {
                MergeNonScalarByEnumDomain(
                    columns, existingIndex, nonScalarMergeDispatch, winnerGetterType, siblingGetterType, siblingSpec);
                return;
            }

            // #339: not the same shape at all (e.g. DMGT's DamageTypes: DamageType's struct-of-
            // formlinks vs DamageTypeIndexed's bare uint) — no field names in common, so there is
            // nothing for a domain union to reconcile. Split into two columns, one per shape.
            SplitNonScalarByShape(columns, existingIndex, winnerGetterType, siblingGetterType, siblingSpec);
            return;
        }

        if (existing.DuckDbType == siblingSpec.DuckDbType && existing.ApiType == siblingSpec.ApiType)
            return; // same shape — shared-ancestor member, existing extractor already reads it fine

        var list = new List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>
        {
            (winnerGetterType, existing.Extract),
            (siblingGetterType, siblingSpec.Extract),
        };
        widenedDispatch[existing.Name] = list;

        object? WidenedExtract(IMajorRecordGetter r)
        {
            foreach (var (type, extract) in list)
                if (type.IsInstanceOfType(r))
                    return FormatWidenedValue(extract(r));
            return null;
        }

        columns[existingIndex] = existing with
        {
            DuckDbType = "VARCHAR",
            ApiType = "string",
            Extract = WidenedExtract,
            Apply = null, // editing a widened value is out of scope (#263) — read-only falls out of
                          // PluginWriter.IsFieldPathReadOnly already treating a null Apply as such
            IsArray = false,
            ElementType = null,
            SubFields = null,
            EnumValues = Empty,
            ValidFormKeyTypes = Empty,
            IsBitmask = false,
            EnumBitValues = null,
            AllowsNull = true,
        };
    }

    // #339: OMOD's Properties rung — every sibling's element is the exact same
    // struct{property: enum, step: float} (IsSameShapeExceptEnumDomain already confirmed this),
    // so unlike the scalar-widen rung above there is no need to give up the typed shape at all.
    // Each sibling's own ReflectColumns call already built a fully self-consistent, correctly-typed
    // Extract for *that* sibling's own runtime type (BuildSchema calls ReflectColumns once per
    // sibling independently) — the defect was only ever that the merged schema kept calling the
    // *winner's* Extract against a foreign instance. Dispatching by runtime type to the matching
    // sibling's own pre-built Extract, exactly like WidenedExtract above, fixes that without any
    // per-element reflection: the raw JSON each sibling's Extract already produces is correctly
    // shaped for its own element type, so nothing here needs to touch it beyond picking the right
    // one to call.
    private static void MergeNonScalarByEnumDomain(
        List<ColumnSpec> columns,
        int existingIndex,
        Dictionary<string, List<(Type Type, Func<IMajorRecordGetter, object?> Extract)>> nonScalarMergeDispatch,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existing = columns[existingIndex];

        // First conflicting sibling seeds the dispatch list with the winner's own Extract; a later
        // conflicting sibling (a fifth OMOD-shaped subclass, hypothetically) extends the same list
        // rather than re-deriving it, exactly like the scalar-widen rung above.
        if (!nonScalarMergeDispatch.TryGetValue(existing.Name, out var list))
            nonScalarMergeDispatch[existing.Name] = list = [(winnerGetterType, existing.Extract)];
        list.Add((siblingGetterType, siblingSpec.Extract));

        object? MergedExtract(IMajorRecordGetter r)
        {
            foreach (var (type, extract) in list)
                if (type.IsInstanceOfType(r))
                    return extract(r);
            return null;
        }

        // The winner's own metadata (element/sub-field shape) is kept as-is — IsSameShapeExceptEnumDomain
        // already confirmed it matches every sibling field-for-field — except any enum leaf's
        // EnumValues, which becomes the union of every sibling's own domain (OMOD's `property`
        // sub-field: Armor.Property ∪ Npc.Property ∪ Weapon.Property ∪ NoneProperty's empty set).
        var mergedElementType = existing.ElementType != null && siblingSpec.ElementType != null
            ? UnionEnumDomains(existing.ElementType, siblingSpec.ElementType)
            : existing.ElementType;
        var mergedSubFields = existing.SubFields != null && siblingSpec.SubFields != null
            ? existing.SubFields.Select(fa =>
                UnionEnumDomains(fa, siblingSpec.SubFields.First(fb => fb.Name == fa.Name))).ToList()
            : existing.SubFields;
        var mergedEnumValues = existing.ApiType == "enum"
            ? existing.EnumValues.Concat(siblingSpec.EnumValues).Distinct().ToList()
            : existing.EnumValues;

        columns[existingIndex] = existing with
        {
            Extract = MergedExtract,
            ElementType = mergedElementType,
            SubFields = mergedSubFields,
            EnumValues = mergedEnumValues,
            // Same reason WidenedExtract's own column sets this above: becoming dispatch-guarded
            // means every row of a non-matching sibling now legitimately reads null through this
            // column — false here would assert a guarantee the dispatch no longer keeps.
            AllowsNull = true,
        };
    }

    // Recursively unions an enum leaf's EnumValues across two structurally-identical-except-domain
    // shapes (IsSameShapeExceptEnumDomain's own counterpart) — every non-enum leaf, and every
    // struct/array's own shape, is already identical, so this only ever changes an enum's member
    // names, never any other field.
    private static FieldMetadata UnionEnumDomains(FieldMetadata a, FieldMetadata b)
    {
        if (a.Type == "enum")
            return a with { EnumValues = a.EnumValues.Concat(b.EnumValues).Distinct().ToList() };
        if (a.Fields != null && b.Fields != null)
            return a with { Fields = a.Fields.Select(fa => UnionEnumDomains(fa, b.Fields.First(fb => fb.Name == fa.Name))).ToList() };
        if (a.ElementType != null && b.ElementType != null)
            return a with { ElementType = UnionEnumDomains(a.ElementType, b.ElementType) };
        return a;
    }

    // #339: a small, hand-curated disambiguation for a split column's name — the same convention
    // RecordDisplayNames already uses for xEdit-sourced display labels, not a merge-decision rule
    // (the decision to split at all is shape-based, made above; only the resulting *label* is
    // curated here, same as RecordDisplayNames/MapToXEditFlagName already do elsewhere in this
    // file). One entry today: DMGT's DamageTypeIndexed shape. xEdit itself never disambiguates
    // this — wbDefinitionsFO4.pas unions both forms under one form-version-gated 'Damage Types'
    // field, since a DamageType record can never be both forms at once — so *some* label is
    // unavoidable here (a genuine platform limitation: Mutagen models the two forms as two
    // co-existing classes, not a version-gated union). 'actor_value_indices' borrows xEdit's own
    // element vocabulary for that shape ('Actor Value Index'), the closest thing to not diverging
    // from xEdit at all (ADR-0034).
    private static readonly Dictionary<string, string> SplitColumnNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["damage_types"] = "actor_value_indices",
    };

    // A plain scalar leaf (no further substructure) — used to decide, shape-based rather than
    // win-order-based, which side of a split keeps the property's own base name. See
    // SplitNonScalarByShape.
    private static bool IsScalarElementShape(FieldMetadata? elementType) =>
        elementType is { Fields: null, ElementType: null };

    private static string QualifiedSplitName(string baseName, ColumnSpec scalarShapeSpec) =>
        SplitColumnNames.TryGetValue(baseName, out var name)
            ? name
            // Shape-derived fallback for an unmapped future conflict (AC: no code change needed) —
            // not pretty, but deterministic and never a table/signature name.
            : $"{baseName}_{scalarShapeSpec.ElementType?.Type ?? scalarShapeSpec.ApiType}";

    // Cheap collision guard for a computed column name (curated or shape-derived-fallback) against
    // whatever is already in `columns` — a curated or fallback name colliding with an unrelated
    // existing column would otherwise reach TableDdlBuilder.CreateRecordTable as two ColumnSpecs
    // sharing one name, which fails the whole table's CREATE TABLE at DDL time, not just this field.
    private static string UniqueColumnName(List<ColumnSpec> columns, string candidate)
    {
        var name = candidate;
        var suffix = 2;
        while (columns.Any(c => c.Name == name))
        {
            name = $"{candidate}_{suffix}";
            suffix++;
        }
        return name;
    }

    // #339: the struct/richer shape always keeps the property's own name; the plain-scalar shape
    // always gets the disambiguated name. This holds regardless of which subclass wins schema
    // discovery (see BuildForCategory's own comment: that race is a reflection-order artifact,
    // never something callers may rely on) — but only for the one-scalar-one-struct pairing DMGT
    // actually exercises, which is what lets this rename an *already-placed* winner column rather
    // than only ever appending the sibling's. It is NOT win-order-independent for a two-scalar or
    // two-struct conflict: IsScalarElementShape can't tell those two apart, so both fall through to
    // the `else` branch below and the discovery winner keeps the base name — the exact reflection-
    // order artifact the guarantee above disclaims. No supported game has that conflict today, and
    // building a shape-based discriminator for it would mean inventing one with nothing real to
    // validate it against; left as a documented gap, not built.
    //
    // Scoped to two siblings — DMGT's only real case today. A hypothetical third sibling sharing
    // one of these two shapes would need to re-resolve which of the two split columns to extend,
    // which this does not attempt (no real data exercises it; #263 left an equivalent gap
    // undocumented in its own lifecycle-delegate carve-out, this one is called out explicitly).
    //
    // Both resulting columns get a type-checked Extract (AC3's "impossible by construction", not a
    // foreign read swallowed by the pre-existing catch-all) — both are new paths this rung adds,
    // the winner's own column included, since it may be the one getting renamed here. Both are also
    // AllowsNull: true — becoming dispatch-guarded means every row of the *other* shape now
    // legitimately reads null through each column, on both sides of the split, not just the newly
    // appended one.
    private static void SplitNonScalarByShape(
        List<ColumnSpec> columns, int existingIndex,
        Type winnerGetterType, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var existing = columns[existingIndex];
        var baseName = existing.Name; // == siblingSpec.Name, that's why they collided above

        var existingIsScalar = IsScalarElementShape(existing.ElementType);
        var siblingIsScalar = IsScalarElementShape(siblingSpec.ElementType);

        if (existingIsScalar && !siblingIsScalar)
        {
            // The winner turned out to be the plain shape — rename it off the base name, then
            // reclaim the base name for the sibling's struct shape, so the result is identical to
            // the opposite win order below.
            var qualified = UniqueColumnName(columns, QualifiedSplitName(baseName, existing));
            columns[existingIndex] = Guarded(existing, winnerGetterType) with { Name = qualified, AllowsNull = true };
            columns.Add(Guarded(siblingSpec, siblingGetterType) with
            {
                Name = UniqueColumnName(columns, baseName),
                AllowsNull = true,
            });
        }
        else
        {
            columns[existingIndex] = Guarded(existing, winnerGetterType) with { AllowsNull = true }; // stays at baseName
            var qualified = UniqueColumnName(columns, QualifiedSplitName(baseName, siblingIsScalar ? siblingSpec : existing));
            columns.Add(Guarded(siblingSpec, siblingGetterType) with { Name = qualified, AllowsNull = true });
        }

        static ColumnSpec Guarded(ColumnSpec spec, Type ownerGetterType)
        {
            var innerExtract = spec.Extract;
            return spec with { Extract = r => ownerGetterType.IsInstanceOfType(r) ? innerExtract(r) : null };
        }
    }

    // #339: the fast-path counterpart to SplitNonScalarByShape, for a sibling that turned out not
    // to share an *already-merged* column's shape (see the nonScalarMergeDispatch branch above) —
    // the merged column is left untouched (it is already correct for every sibling folded into it),
    // so this only ever adds the mismatched sibling as its own column, guarded the same way.
    private static void AddAsOwnColumn(List<ColumnSpec> columns, Type siblingGetterType, ColumnSpec siblingSpec)
    {
        var innerExtract = siblingSpec.Extract;
        var name = UniqueColumnName(columns, QualifiedSplitName(siblingSpec.Name, siblingSpec));
        columns.Add(siblingSpec with
        {
            Name = name,
            Extract = r => siblingGetterType.IsInstanceOfType(r) ? innerExtract(r) : null,
            AllowsNull = true,
        });
    }

    // Every prior VARCHAR column already held a real string; a widened scalar column is the first
    // one to hand AppendTyped a raw boxed *numeric* value, and AppendTyped's own VARCHAR branch is
    // a bare value.ToString() with no culture — so on any non-en-US host a widened float/int would
    // round-trip through the current culture's separators (e.g. "3,5" under de-DE) instead of the
    // actual value. Format explicitly with InvariantCulture here, for every IFormattable scalar
    // (int, float, uint, ... — not just the bool case below), so the column's text is culture-
    // stable the same way every other numeric formatting in this file already is (see e.g.
    // GetEnumMeta's bit values). bool doesn't implement IFormattable, so it keeps its own case:
    // lowercase "true"/"false" (JS-idiomatic) rather than C#'s "True"/"False" — cosmetic, and
    // shape- not signature-scoped. Anything neither (e.g. an already-string value) passes through
    // unchanged. Affects only columns that previously read null for these siblings, so it
    // regresses nothing.
    private static object? FormatWidenedValue(object? value) => value switch
    {
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value,
    };

    // ── ColumnInfoResult ──────────────────────────────────────────────────────

    private sealed record ColumnInfoResult(
        string DuckDbType,
        Func<IMajorRecordGetter, object?> Extractor,
        string ApiType,
        string[] ValidFormKeyTypes,
        string[] EnumValues,
        Action<IMajorRecord, JsonElement>? Apply,
        FieldMetadata? ElementMeta = null,
        IReadOnlyList<FieldMetadata>? SubFieldMetas = null,
        bool AllowsNull = false,
        bool IsBitmask = false,
        string[]? EnumBitValues = null);

    // ── SubFieldSpec (sub-record / array element reflection) ─────────────────

    private sealed record SubFieldSpec(
        string Name,
        string ApiType,
        string[] ValidFormKeyTypes,
        string[] EnumValues,
        Func<object, object?> Extract,
        Action<object, JsonElement>? Apply,
        IReadOnlyList<SubFieldSpec>? SubFields = null,
        SubFieldSpec? ElementSpec = null,
        bool AllowsNull = false,
        bool IsBitmask = false,
        string[]? EnumBitValues = null)
    {
        public FieldMetadata ToFieldMetadata() =>
            new(Name, ApiType, false, ValidFormKeyTypes, EnumValues,
                ElementSpec?.ToFieldMetadata(),
                SubFields?.Select(s => s.ToFieldMetadata()).ToList(),
                AllowsNull: AllowsNull,
                IsBitmask: IsBitmask,
                EnumBitValues: EnumBitValues);
    }

    // ── Type-detection helpers ────────────────────────────────────────────────

    private static readonly string[] Empty = [];

    private static readonly HashSet<string> LoquiSkipProps =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "CommonInstance", "CommonSetterInstance", "CommonSetterTranslationInstance",
            "StaticRegistration", "Registration",
        };

    private static IEnumerable<PropertyInfo> GetAllInterfaceProperties(Type type) =>
        type.GetInterfaces()
            .Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance));

    private static bool IsTranslatedString(Type type) =>
        typeof(ITranslatedStringGetter).IsAssignableFrom(type);

    private static bool IsFormLink(Type type) =>
        typeof(IFormLinkGetter).IsAssignableFrom(type);

    // On *Getter interfaces (what SchemaReflector walks), a non-nullable FormLink property is exposed
    // as the ambiguous base IFormLinkGetter<T> — the same static type a nullable property would have
    // if Mutagen didn't bother marking it. Only explicitly-nullable properties get the distinct marker
    // interface IFormLinkNullableGetter<T>, so that's the only type-level signal we can trust.
    private static bool IsNullableFormLink(Type type) =>
        type.GetInterfaces().Prepend(type).Any(i =>
            i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IFormLinkNullableGetter<>));

    // IReadOnlyList<T> only — that's what Mutagen getter interfaces expose for collections.
    private static bool IsListType(Type type, out Type elementType)
    {
        elementType = typeof(object);
        if (!type.IsGenericType) return false;
        if (type.GetGenericTypeDefinition() != typeof(IReadOnlyList<>)) return false;
        elementType = type.GetGenericArguments()[0];
        return true;
    }

    // Mutagen Loqui-generated sub-record interfaces always declare a static StaticRegistration.
    private static bool IsLoquiInterface(Type type) =>
        type.IsInterface &&
        !IsFormLink(type) &&
        type.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;

    private static string[] GetFormLinkValidTypes(
        Type core, IReadOnlyDictionary<Type, string> getterTypeToTable)
    {
        var linked = core.IsGenericType ? core.GetGenericArguments()[0] : null;
        return linked != null && getterTypeToTable.TryGetValue(linked, out var tn)
            ? [tn] : Empty;
    }

    // Retrieve the concrete mutable class (e.g. RankPlacement) via ILoquiRegistration.SetterType.
    private static Type? GetSetterType(Type getterInterface)
    {
        var regProp = getterInterface.GetProperty(
            "StaticRegistration", BindingFlags.Public | BindingFlags.Static);
        var reg = regProp?.GetValue(null);
        return reg?.GetType().GetField("ClassType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) as Type;
    }

    // ── Sub-schema building ───────────────────────────────────────────────────

    // #360: this walks only the properties declared on getterInterface and the interfaces it
    // implements/inherits — never a more-derived sibling interface. OMOD's Properties element
    // type, IAObjectModPropertyGetter<T>, declares only Property/Step; the real per-element data
    // (Value) lives on 7 separate leaf getter interfaces (IObjectModIntPropertyGetter<T>,
    // IObjectModFloatPropertyGetter<T>, ...), each implementing IAObjectModPropertyGetter<T>
    // rather than the other way around, so Value is never descended into here. Confirmed by
    // dumping the real reflected shape, not assumed: today's "structured" omod Properties column —
    // winner and every #339-merged sibling alike — surfaces property + step only, never value.
    // Predates #339 and is unaffected by it (whose AC only requires parity with what the winner
    // already showed) — this affects every subclass, discovery winner included, so nobody reads
    // "structured list" here and assumes the value is in it.
    private static List<SubFieldSpec> BuildSubSchema(
        Type getterInterface,
        IReadOnlyDictionary<Type, string> getterTypeToTable,
        ILogger logger,
        int depth = 0)
    {
        if (depth > 3) return [];

        var grouped = GetAllInterfaceProperties(getterInterface)
            .Where(p => !LoquiSkipProps.Contains(p.Name))
            .GroupBy(p => ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase);

        var result = new List<SubFieldSpec>();
        foreach (var group in grouped)
        {
            var prop = group.Aggregate((best, candidate) =>
                best.DeclaringType!.IsAssignableFrom(candidate.DeclaringType!) ? candidate : best);

            var spec = GetSubFieldInfo(prop, getterTypeToTable, depth + 1, logger);
            if (spec != null) result.Add(spec);
        }
        return result;
    }

    // Element metadata for use in FieldMetadata.ElementType.
    private static FieldMetadata? BuildElementMeta(
        Type elementType, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var core = Nullable.GetUnderlyingType(elementType) ?? elementType;

        if (IsFormLink(core))
        {
            // Array elements are commonly sparse (a "Null" slot is a tolerated placeholder, not a
            // data error) — getter interfaces can't statically distinguish this from a non-nullable
            // scalar anyway (see IsNullableFormLink), so default permissive here regardless.
            return new FieldMetadata("", "formKey", false,
                GetFormLinkValidTypes(core, getterTypeToTable), Empty,
                IsSortable: true, AllowsNull: true);
        }

        if (IsLoquiInterface(core))
        {
            var sub = BuildSubSchema(core, getterTypeToTable, logger);
            return sub.Count == 0
                ? null
                : new FieldMetadata("", "struct", false, Empty, Empty,
                Fields: [.. sub.Select(s => s.ToFieldMetadata())]);
        }

        return core switch
        {
            _ when core == typeof(float) => new("", "float", false, Empty, Empty),
            _ when core == typeof(string) || IsTranslatedString(core) => new("", "string", false, Empty, Empty),
            _ when IntegerTypes.Contains(core) => new("", "int", false, Empty, Empty),
            _ => null,
        };
    }

    private static readonly HashSet<Type> IntegerTypes =
    [
        typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(long), typeof(ulong),
    ];

    // ── Primitive type dispatch shared by GetColumnInfo and GetSubFieldInfo ─────

    private static readonly Dictionary<Type, (string DuckDbType, string ApiType, Func<JsonElement, object?> Converter)> PrimitiveMap = new()
    {
        [typeof(bool)] = ("BOOLEAN", "bool", v => (object)v.GetBoolean()),
        [typeof(byte)] = ("INTEGER", "int", v => (object)(byte)v.GetInt32()),
        [typeof(sbyte)] = ("INTEGER", "int", v => (object)(sbyte)v.GetInt32()),
        [typeof(short)] = ("INTEGER", "int", v => (object)(short)v.GetInt32()),
        [typeof(ushort)] = ("INTEGER", "int", v => (object)(ushort)v.GetInt32()),
        [typeof(int)] = ("INTEGER", "int", v => (object)v.GetInt32()),
        [typeof(uint)] = ("INTEGER", "int", v => (object)v.GetUInt32()),
        [typeof(ulong)] = ("BIGINT", "int", v => (object)v.GetUInt64()),
        [typeof(float)] = ("FLOAT", "float", v => (object)v.GetSingle()),
        [typeof(string)] = ("VARCHAR", "string", v => v.GetString()),
    };

    private static bool TryMapPrimitive(
        Type core,
        out string duckDbType,
        out string apiType,
        out Func<JsonElement, object?> converter)
    {
        if (PrimitiveMap.TryGetValue(core, out var mapped))
        {
            (duckDbType, apiType, converter) = mapped;
            return true;
        }
        duckDbType = ""; apiType = ""; converter = _ => null;
        return false;
    }

    private static (string[] Names, string[]? BitValues) GetEnumMeta(Type enumType)
    {
        var allNames = Enum.GetNames(enumType);
        if (enumType.GetCustomAttribute<FlagsAttribute>() == null)
            return (allNames, null);

        var allValues = Enum.GetValues(enumType);
        var names = new List<string>();
        var bits = new List<string>();
        for (int i = 0; i < allValues.Length; i++)
        {
            long v = Convert.ToInt64(allValues.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);
            if (v > 0 && (v & (v - 1)) == 0)   // atomic power-of-two only; excludes None=0 and composite values
            {
                names.Add(allNames[i]);
                bits.Add(v.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        }
        return bits.Count > 0 ? (names.ToArray(), bits.ToArray()) : (allNames, null);
    }

    // Bitmask flag values travel as decimal strings (to survive JSON above 2^53) but legacy
    // callers may still send numbers. Accept either JSON token kind.
    private static long ReadBitmaskLong(JsonElement v) =>
        v.ValueKind == JsonValueKind.String
            ? long.Parse(v.GetString()!, System.Globalization.CultureInfo.InvariantCulture)
            : v.GetInt64();

    // ── Shared leaf classification (column ⇄ sub-field) ───────────────────────
    // The neutral facts a leaf field carries, independent of whether it becomes a top-level
    // column or a struct/array sub-field. Get reads the raw value from any instance; Convert
    // turns a JSON token into the value to write — null means "no generic applier" (form-links
    // supply their own per context: read-only as a column, ApplyFormLinkJson as a sub-field).
    private sealed record LeafSpec(
        string ApiType,
        string DuckDbType,
        string[] ValidFormKeyTypes,
        string[] EnumValues,
        Func<object, object?> Get,
        Func<JsonElement, object?>? Convert,
        bool AllowsNull = false,
        bool IsBitmask = false,
        string[]? EnumBitValues = null);

    // Classifies the leaf kinds shared by both dispatch paths: primitive, translated-string,
    // enum, form-link. Returns null for list/loqui-struct — the callers handle those.
    private static LeafSpec? ClassifyLeaf(
        PropertyInfo prop, Type core, IReadOnlyDictionary<Type, string> getterTypeToTable)
    {
        if (TryMapPrimitive(core, out var duckDb, out var apiType, out var conv))
            return new(apiType, duckDb, Empty, Empty, SubGetter(prop), conv);

        if (IsTranslatedString(core))
        {
            var g = SubGetter(prop);
            return new("string", "VARCHAR", Empty, Empty,
                obj => { try { return (g(obj) as ITranslatedStringGetter)?.String; } catch { return null; } }, // Stryker disable once Block: silent accessor lambda — lookup-backed strings throw when game strings files are absent (see MEditService CLAUDE.md)
                v => new TranslatedString(Language.English, v.GetString()));
        }

        if (core.IsEnum)
            return ClassifyEnumLeaf(prop, core);

        if (IsFormLink(core))
        {
            var g = SubGetter(prop);
            return new("formKey", "VARCHAR", GetFormLinkValidTypes(core, getterTypeToTable), Empty,
                obj => (g(obj) as IFormLinkGetter)?.FormKeyNullable?.ToString(),
                Convert: null,
                AllowsNull: IsNullableFormLink(core));
        }

        return null;
    }

    // Enum leaf, shared by both projections. Bitmask ([Flags] with power-of-two members) stores as
    // BIGINT and round-trips through decimal strings; a plain enum stores its name as VARCHAR.
    private static LeafSpec ClassifyEnumLeaf(PropertyInfo prop, Type core)
    {
        var g = SubGetter(prop);
        var (names, bits) = GetEnumMeta(core);
        return bits != null
            ? new("enum", "BIGINT", Empty, names,
                obj => g(obj) is { } v ? (object?)Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) : null,
                v => Enum.ToObject(core, ReadBitmaskLong(v)),
                IsBitmask: true, EnumBitValues: bits)
            : new("enum", "VARCHAR", Empty, names,
            obj => g(obj)?.ToString(),
            v => Enum.Parse(core, v.GetString()!, ignoreCase: true));
    }

    // The one applier shared by columns and sub-fields: writes a converted JSON value onto a
    // property, tolerating a missing property and (when nullable) a JSON null. Operates on
    // `object`; the column path adapts the IMajorRecord receiver via MakeColumnApplier.
    private static Action<object, JsonElement> MakeApplier(string pName, bool nullable, Func<JsonElement, object?> conv)
    {
        var cache = new ConcurrentDictionary<Type, PropertyInfo?>();
        return (obj, val) =>
        {
            var rp = cache.GetOrAdd(obj.GetType(), t =>
                t.GetProperty(pName, BindingFlags.Public | BindingFlags.Instance));
            if (rp == null) return;
            if (val.ValueKind == JsonValueKind.Null)
            {
                if (nullable) rp.SetValue(obj, null);
                return;
            }
            var v = conv(val);
            if (v != null) rp.SetValue(obj, v);
        };
    }

    private static Action<IMajorRecord, JsonElement> MakeColumnApplier(string pName, bool nullable, Func<JsonElement, object?> conv)
    {
        var applier = MakeApplier(pName, nullable, conv);
        return (record, val) => applier(record, val);
    }

    // ── Per-sub-field reflection (operates on object, not IMajorRecordGetter) ─

    private static SubFieldSpec? GetSubFieldInfo(
        PropertyInfo prop,
        IReadOnlyDictionary<Type, string> getterTypeToTable,
        int depth,
        ILogger logger)
    {
        if (depth > 3) return null;

        var type = prop.PropertyType;
        var core = Nullable.GetUnderlyingType(type) ?? type;
        var nullable = Nullable.GetUnderlyingType(type) != null || !type.IsValueType;
        var colName = ToSnakeCase(prop.Name);

        return ClassifyLeaf(prop, core, getterTypeToTable) switch
        {
            { } leaf => ProjectSubField(prop, colName, core, nullable, leaf, logger),
            null when IsLoquiInterface(core) => BuildStructSubField(prop, core, colName, getterTypeToTable, depth, logger),
            _ => null,
        };
    }

    // Projects a shared LeafSpec into a sub-field. Generic leaves (primitive / enum / translated-
    // string) use the shared applier; a form-link (its Convert is null) gets ApplyFormLinkJson —
    // the one place a sub-field form-link differs from its read-only column counterpart.
    private static SubFieldSpec ProjectSubField(
        PropertyInfo prop, string colName, Type core, bool nullable, LeafSpec leaf, ILogger logger)
    {
        var pName = prop.Name;
        Action<object, JsonElement>? apply = leaf.Convert switch
        {
            { } c => MakeApplier(pName, nullable, c),
            null when IsFormLink(core) => (obj, val) => ApplyFormLinkJson(obj, val, pName, logger),
            _ => null,
        };
        return new(colName, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumValues,
            leaf.Get, apply,
            AllowsNull: leaf.AllowsNull, IsBitmask: leaf.IsBitmask, EnumBitValues: leaf.EnumBitValues);
    }

    private static Func<object, object?> SubGetter(PropertyInfo prop) =>
        obj => { try { return prop.GetValue(obj); } catch { return null; } };

    private static void ApplyFormLinkJson(object obj, JsonElement val, string pName, ILogger logger)
    {
        try
        {
            var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
            if (rp == null) return;
            if (val.ValueKind == JsonValueKind.Null)
            { (rp.GetValue(obj))?.GetType().GetMethod("Clear")?.Invoke(rp.GetValue(obj), []); return; }
            var fkStr = val.GetString();
            if (fkStr == null || !FormKey.TryFactory(fkStr, out var fk)) return;
            var link = rp.GetValue(obj);
            link?.GetType().GetMethod("SetTo", [typeof(FormKey)])?.Invoke(link, [fk]);
        }
        catch (Exception ex) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
    }

    private static SubFieldSpec? BuildStructSubField(
        PropertyInfo prop, Type core, string colName,
        IReadOnlyDictionary<Type, string> getterTypeToTable, int depth, ILogger logger)
    {
        var sub = BuildSubSchema(core, getterTypeToTable, logger, depth);
        if (sub.Count == 0) return null;
        var g = SubGetter(prop);
        return new(colName, "struct", Empty, Empty,
            obj => { var v = g(obj); return v == null ? null : ExtractSubObject(v, sub); },
            Apply: null,
            SubFields: sub);
    }

    // ── Serialization helpers ─────────────────────────────────────────────────

    private static Dictionary<string, object?> ExtractSubObject(
        object item, IReadOnlyList<SubFieldSpec> fields)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var f in fields) dict[f.Name] = f.Extract(item);
        return dict;
    }

    private static string? SerializeListItems(
        IEnumerable items, Type elementType, IReadOnlyList<SubFieldSpec>? subFields)
    {
        var isFl = IsFormLink(elementType);
        var result = new List<object?>();
        foreach (var item in items)
        {
            if (isFl) result.Add((item as IFormLinkGetter)?.FormKeyNullable?.ToString());
            else if (subFields != null) result.Add(ExtractSubObject(item, subFields));
            else result.Add(item);
        }
        return JsonSerializer.Serialize(result);
    }

    // ── GetColumnInfo ─────────────────────────────────────────────────────────

    private static ColumnInfoResult? GetColumnInfo(
        PropertyInfo prop, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var type = prop.PropertyType;
        var core = Nullable.GetUnderlyingType(type) ?? type;
        var nullable = Nullable.GetUnderlyingType(type) != null || !type.IsValueType;

        return ClassifyLeaf(prop, core, getterTypeToTable) switch
        {
            { } leaf => ProjectColumn(prop, nullable, leaf),
            null when IsListType(core, out var elementType) => BuildListColumn(prop, elementType, getterTypeToTable, logger),
            null when IsLoquiInterface(core) => BuildStructColumn(prop, core, getterTypeToTable, logger),
            _ => null,
        };
    }

    // Projects a shared LeafSpec into a top-level column. A form-link leaf (Convert null) yields a
    // null Apply — top-level form-link columns are read-only in the index.
    private static ColumnInfoResult ProjectColumn(PropertyInfo prop, bool nullable, LeafSpec leaf) =>
        new(leaf.DuckDbType, r => leaf.Get(r), leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumValues,
            leaf.Convert is { } c ? MakeColumnApplier(prop.Name, nullable, c) : null,
            AllowsNull: leaf.AllowsNull, IsBitmask: leaf.IsBitmask, EnumBitValues: leaf.EnumBitValues);

    // ── IReadOnlyList<T> ──────────────────────────────────────────────────────

    private static ColumnInfoResult? BuildListColumn(
        PropertyInfo prop, Type elementType, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var isFl = IsFormLink(elementType);
        var isLoqui = !isFl && IsLoquiInterface(elementType);

        IReadOnlyList<SubFieldSpec>? elemSubFields = isLoqui
            ? BuildSubSchema(elementType, getterTypeToTable, logger) : null;

        var elemMeta = BuildElementMeta(elementType, getterTypeToTable, logger);
        if (elemMeta == null) return null;

        object? Extractor(IMajorRecordGetter r)
        {
            try // Stryker disable once Block: per-call accessor lambda stays silent per MEditService CLAUDE.md; SerializeListItems can throw on unusual record types in real game data
            {
                return TryGet(r, prop) is IEnumerable list
                    ? SerializeListItems(list, elementType, elemSubFields)
                    : null;
            }
            catch { return null; }
        }

        var pName = prop.Name;
        Action<IMajorRecord, JsonElement>? apply = isFl || isLoqui
            ? (record, json) => ApplyListJson(record, json, pName, isFl, elementType, elemSubFields)
            : null;

        return new("VARCHAR", Extractor, "array", Empty, Empty, apply,
            ElementMeta: elemMeta);
    }

    private static void ApplyListJson(
        IMajorRecord record, JsonElement json, string pName,
        bool isFl, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (json.ValueKind != JsonValueKind.Array) return;
        var rp = record.GetType()
            .GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;

        var listType = rp.PropertyType;
        var newList = Activator.CreateInstance(listType)!;
        var addMethod = listType.GetMethod("Add")!;

        foreach (var elem in json.EnumerateArray())
        {
            var item = BuildListElement(elem, isFl, elemCore, listType, subFields);
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        rp.SetValue(record, newList);
    }

    private static object? BuildListElement(
        JsonElement elem, bool isFl, Type elemCore, Type listType, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (isFl)
        {
            var fkStr = elem.GetString();
            if (fkStr == null || !FormKey.TryFactory(fkStr, out var fk)) return null;
            var flType = typeof(FormLink<>).MakeGenericType(elemCore.GetGenericArguments()[0]);
            return Activator.CreateInstance(flType, fk);
        }

        // Derive the concrete element type from the mutable list's generic argument,
        // not from GetSetterType — which returns the setter *interface* (e.g.
        // IRankPlacement), not the instantiable concrete class (RankPlacement).
        var elemConcreteType = listType.GetGenericArguments()[0];
        var elemObj = Activator.CreateInstance(elemConcreteType)!;
        ApplySubFields(elemObj, elem, subFields!);
        return elemObj;
    }

    private static void ApplySubFields(object target, JsonElement json, IReadOnlyList<SubFieldSpec> subFields)
    {
        foreach (var sf in subFields)
        {
            if (json.TryGetProperty(sf.Name, out var sfVal))
                sf.Apply!(target, sfVal);
        }
    }

    // ── Loqui struct (sub-record) ─────────────────────────────────────────────

    private static ColumnInfoResult? BuildStructColumn(
        PropertyInfo prop, Type core, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var subFields = BuildSubSchema(core, getterTypeToTable, logger);
        if (subFields.Count == 0) return null;

        var subFieldMetas = subFields.ConvertAll(s => s.ToFieldMetadata());

        object? Extractor(IMajorRecordGetter r)
        {
            var obj = TryGet(r, prop);
            return obj == null ? null
                : JsonSerializer.Serialize(ExtractSubObject(obj, subFields));
        }

        var setterType = GetSetterType(core);
        var pName = prop.Name;
        Action<IMajorRecord, JsonElement>? apply = null;
        if (setterType != null)
        {
            apply = (record, json) =>
            {
                if (json.ValueKind != JsonValueKind.Object) return;
                var rp = record.GetType()
                    .GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;
                var obj = rp.GetValue(record) ?? Activator.CreateInstance(setterType)!;
                ApplySubFields(obj, json, subFields);
                if (rp.CanWrite) rp.SetValue(record, obj);
            };
        }

        return new("VARCHAR", Extractor, "struct", Empty, Empty, apply,
            SubFieldMetas: subFieldMetas);
    }

    private static object? TryGet(IMajorRecordGetter record, PropertyInfo prop)
    {
        try { return prop.GetValue(record); }
        catch { return null; } // Stryker disable once Block: silent accessor lambda — per-call lambdas stay silent to avoid log noise (see MEditService CLAUDE.md)
    }

    internal static string ToSnakeCase(string name) =>
        SnakeCaseBoundary().Replace(name, "_$1").ToLowerInvariant();

    [GeneratedRegex("(?<=[a-z0-9])([A-Z])")]
    private static partial Regex SnakeCaseBoundary();
}
