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
using Noggog;

namespace MEditService.Core.Schema;

public sealed partial class SchemaReflector(ILogger<SchemaReflector>? logger = null) : ISchemaReflector
{
    // Stryker disable once NullCoalescing: logger init; only usage is a defensive LogTrace in catch — unreachable from tests without artificial exception injection
    private readonly ILogger _logger = logger ?? NullLogger<SchemaReflector>.Instance;

    // Issue #110: these two sets were one undifferentiated list, mixing two unrelated rules.
    // Split so each is documented on its own terms; `pfo2` (formerly in this list) was dead —
    // it's a PACK sub-record struct field (wbStruct(PFO2, 'Data', ...) in wbDefinitionsFO4.pas),
    // never a top-level Mutagen record type, so it could never have been discovered here anyway.

    // Deliberate product filter: not standard editable refs (placed refr/achr are
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

    // #445: keyed by category (not release) because the assembly is category-wide — a `null` entry
    // means that category's assembly was probed once and found unreferenced, cached so a repeated
    // ask never re-attempts the load or re-logs the warning below.
    private readonly ConcurrentDictionary<GameCategory, Assembly?> _assemblyByCategory = new();

    public IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release)
    {
        var category = release.ToCategory();
        var assembly = ResolveAssembly(release, category)
            ?? throw new UnsupportedGameReleaseException(release, AssemblyNameFor(category));
        return GetCache(category, assembly).Schemas;
    }

    /// <inheritdoc />
    public bool IsSupported(GameRelease release) => ResolveAssembly(release, release.ToCategory()) is not null;

    private static string AssemblyNameFor(GameCategory category) => $"Mutagen.Bethesda.{category}";

    // The one place that probes whether a category's Mutagen assembly is loadable. Never throws:
    // a `FileNotFoundException` from `Assembly.Load` means "not referenced in this build", which is
    // reported (cached `null`, one warning) rather than propagated — GetSchemas is what turns an
    // unsupported category into a typed refusal for a caller that actually needs one.
    private Assembly? ResolveAssembly(GameRelease release, GameCategory category) =>
        _assemblyByCategory.GetOrAdd(category, c => ProbeAssembly(release, c, _logger));

    private static Assembly? ProbeAssembly(GameRelease release, GameCategory category, ILogger logger)
    {
        var assemblyName = AssemblyNameFor(category);
        var loaded = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == assemblyName);
        if (loaded != null) return loaded;

        try
        {
            return Assembly.Load(assemblyName);
        }
        catch (FileNotFoundException ex)
        {
            logger.LogWarning(ex,
                "Game release {Release} is unavailable: Mutagen assembly {AssemblyName} is not referenced in this build",
                release, assemblyName);
            return null;
        }
    }

    private GameSchemaCache GetCache(GameCategory category, Assembly assembly) =>
        _cache.GetOrAdd(category, c => BuildForCategory(c, assembly, _logger));

    private static GameSchemaCache BuildForCategory(GameCategory category, Assembly assembly, ILogger logger)
    {
        var majorRecordGetterType =
            assembly.GetType($"Mutagen.Bethesda.{category}.I{category}MajorRecordGetter")!;

        // #263: a GRUP signature can be backed by several concrete Mutagen subclasses sharing one
        // abstract base — GameSettingInt/Float/String/Bool/UInt are all GMST, GlobalInt/Float/
        // Short/Bool are all GLOB, DamageType/DamageTypeIndexed are both DMGT — because the type
        // discriminant lives on the record itself (an EditorID prefix, a subrecord, ...), never on
        // the table. `discovered`/`seenTables` still record one winner per table (RecordType stays
        // bound to it, deliberately unchanged by this fix — see BuildSchema), but `siblingsByTable`
        // keeps every concrete type sharing a signature so BuildSchema can union their columns
        // instead of the loser's shape being silently dropped (issue #263: that drop is why a
        // GameSetting's Data column only ever worked for whichever subclass reflection happened to
        // enumerate first).
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

        // #178: resolved once per category (condition codecs are stateless per-call factories,
        // and the codec itself doesn't vary per table) — passed into BuildSchema so it can skip
        // condition-shaped properties the same way baseSkip skips other fields, keeping the
        // Conditions section (Fallout4ConditionCodec.Extract) as the one place they're surfaced.
        var conditionCodec = ConditionCodecRegistry.For(category);

        // #179: resolved once per category, game-neutral like everything else here — each game
        // assembly declares its own IHaveVirtualMachineAdapterGetter in its flat
        // Mutagen.Bethesda.{category} namespace (no shared cross-game interface exists), the same
        // one Records/DuckDbRecordIndex.IndexVmad keys off for a given game's compiled type.
        // Null (a hypothetical future game without the concept) means no table in that category
        // can ever carry VMAD.
        var vmadInterfaceType = assembly.GetType($"Mutagen.Bethesda.{category}.IHaveVirtualMachineAdapterGetter");

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            schemas[tableName] = BuildSchema(
                tableName, getterType, siblingsByTable[tableName],
                getterTypeToTable, logger, conditionCodec, vmadInterfaceType);
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
            applies.Add(HeaderPropertyApply(modHeaderProp, authorProp.Name, nullable: true, authorLeaf.Convert, logger));
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
            applies.Add(HeaderPropertyApply(modHeaderProp, flagsProp.Name, nullable: false, flagsLeaf.Convert, logger));
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
        PropertyInfo modHeaderProp, string propName, bool nullable, Func<JsonElement, object?>? convert, ILogger logger)
    {
        if (convert == null) return null;
        var applier = MakeApplier(propName, nullable, convert, logger);
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

    // #413: the three GRUP-timestamp properties join this list for the same reason
    // MajorRecordFlagsRaw and FormVersion are already on it — they are not record data. A timestamp
    // here belongs to the GRUP that contains the record, not to the record, so it stays out of the
    // queryable schema on that ground alone (ADR-0042's own file/view-layer split: the source
    // document is the lossless side, this reflected schema is the queryable-projection side, and the
    // two are allowed to diverge here on purpose).
    //
    // #470 correction: this comment used to also justify the skip by "the per-record serializer
    // accordingly never emits one". That premise is gone — RecordTextCodecCustomization no longer
    // omits Cell.PersistentTimestamp/TemporaryTimestamp or Worldspace.SubCellsTimestamp from the
    // *file* (ADR-0042 decision 3 now has no exception), so <Type>_Serialization does write these
    // properties today. The skip itself is unaffected: GrupTimestamps_AreAbsentFromSchemaAndViewsAlike
    // still holds, and still should, on the GRUP-ownership argument above — a reflected column and a
    // source-document field are different promises, and only the file's is required to be lossless.
    //
    // CAVEAT for whoever hits this next: the skip is BY PROPERTY NAME ACROSS EVERY RECORD TYPE. If a
    // future game has a record type where Timestamp/TemporaryTimestamp/PersistentTimestamp is
    // genuine per-record data rather than GRUP metadata, this list would wrongly drop it. The rule to
    // re-verify is whether the field is conceptually the record's own data or its containing GRUP's
    // — not "extend the list because a new name looks similar", and no longer "does the serializer
    // emit it", since #470 means that question no longer distinguishes the two cases.
    private static readonly HashSet<string> BaseSkip = new(StringComparer.OrdinalIgnoreCase)
    {
        "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl",
        "MajorRecordFlagsRaw", "SubgraphRevision",
        "Timestamp", "TemporaryTimestamp", "PersistentTimestamp"
    };

    // #263: RecordType (used for enumeration in DuckDbRecordIndex.IndexRecordTable) stays bound to
    // the discovery winner, deliberately, even though RecordColumns below is unioned across every
    // sibling. Enumeration already returns every sibling's records no matter which one's getter
    // interface is named — Mutagen's own EnumerateMajorRecords falls back through
    // InheritingInterfaceMapping to the abstract group base (e.g. IGameSettingGetter) and the group
    // enumerator returns every element once the requested type is assignable to it. Rows were never
    // dropped; only the Data column's extraction was broken. So RecordType has nothing to gain from
    // pointing at the abstract base.
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
                EnumBitValues: info.EnumBitValues,
                IsFlagsEnum: info.IsFlagsEnum,
                ViewDefaultLiteral: info.ViewDefaultLiteral));
        }

        return columns;
    }

    // A column's ApiType that means "not a single scalar value" — reflection produces these two
    // (BuildListColumn / BuildStructColumn); everything else GetColumnInfo can return is scalar.
    private static readonly HashSet<string> NonScalarApiTypes = new(StringComparer.Ordinal) { "array", "struct" };

    // #339: distinguishes OMOD's Properties (mergeable — every sibling's element is the same
    // struct{property: enum, step: float, plus #360's sparse union of the seven leaf types' own
    // value/value2/record/function_type/enum_int_value}, only the enum's own member-name domain
    // differs per sibling — #360's own union is independent of T, so it's identical across every
    // sibling too) from DMGT's DamageTypes (not mergeable — DamageType's element is a struct of two
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
    //     element is the same struct, #360's own seven-leaf sparse union included, only the "which
    //     property" enum's own domain differs): merge into one column, keeping the typed shape and
    //     dispatching Extract to whichever sibling's own (already-correct) reflected Extract
    //     matches the record's runtime type — never a foreign one. See MergeNonScalarByEnumDomain.
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
            // #413: the marker generated views key off, set at the one rung that creates this shape
            // rather than re-derived later from a heuristic over the resulting column.
            IsWidened = true,
            ViewDefaultLiteral = null,
            IsFlagsEnum = false,
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

    // #339: OMOD's Properties rung — every sibling's element is the exact same struct shape
    // (IsSameShapeExceptEnumDomain already confirmed this, #360's own union included — see that
    // method's own comment), so unlike the scalar-widen rung above there is no need to give up the
    // typed shape at all.
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

        columns[existingIndex] = existing with
        {
            Extract = MergedExtract,
            ElementType = mergedElementType,
            SubFields = mergedSubFields,
            // existing.EnumValues is left untouched here (never unioned): this function is only
            // reached once IsSameColumnShapeExceptEnumDomain has confirmed existing.ApiType ==
            // siblingSpec.ApiType, and both of this function's callers are themselves gated behind
            // NonScalarApiTypes.Contains(existing.ApiType) — array or struct only, never "enum" — so
            // the top-level column's own EnumValues has nothing to union here. The real per-leaf
            // enum-domain union (OMOD's `property` sub-field) happens above, inside UnionEnumDomains.
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
        Func<IMajorRecord, JsonElement, ApplyOutcome>? Apply,
        FieldMetadata? ElementMeta = null,
        IReadOnlyList<FieldMetadata>? SubFieldMetas = null,
        bool AllowsNull = false,
        bool IsBitmask = false,
        string[]? EnumBitValues = null,
        bool IsFlagsEnum = false,
        string? ViewDefaultLiteral = null);

    // ── SubFieldSpec (sub-record / array element reflection) ─────────────────

    private sealed record SubFieldSpec(
        string Name,
        string ApiType,
        string[] ValidFormKeyTypes,
        string[] EnumValues,
        Func<object, object?> Extract,
        Func<object, JsonElement, ApplyOutcome>? Apply,
        IReadOnlyList<SubFieldSpec>? SubFields = null,
        SubFieldSpec? ElementSpec = null,
        bool AllowsNull = false,
        bool IsBitmask = false,
        string[]? EnumBitValues = null)
    {
        // #541: used to hardcode false — dead until BuildListSubField gave this record its first
        // list-shaped instance (a struct/array-element sub-field, e.g. Destructible.Resistances/
        // Stages). Mirrors ColumnSpec.IsArray's own derivation (ReflectColumns: `info.ApiType ==
        // "array"`) rather than adding a redundant constructor flag that could disagree with ApiType.
        public FieldMetadata ToFieldMetadata() =>
            new(Name, ApiType, ApiType == "array", ValidFormKeyTypes, EnumValues,
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

    // #541 (P3Int16, P3Float) widened by #546 to the rest of Noggog's small value-vector struct
    // family — plain structs (not Loqui interfaces: no StaticRegistration), each with two or three
    // scalar members named X, Y, and optionally Z. Real FO4 examples of each, found by grepping
    // references/Mutagen/Mutagen.Bethesda.Fallout4 rather than assumed: ObjectBounds.First/Second
    // (P3Int16), several top-level fields such as Placed*.Position and IslandData.Min/Max plus
    // several struct sub-fields such as PlacedObject.TeleportDestination.Position/Rotation (P3Float),
    // Cell.Grid.Point (P2Int), WorldspaceMaxHeight.Min/Max and several others, also reachable as a
    // list element on LocationCoordinate.Coordinates (P2Int16), WorldDefaultLevelData's two
    // cell-coord fields (P2UInt8), LandscapeVertexHeightMap.Unknown (P3UInt8),
    // RegionObject.AngleVariance (P3UInt16), and ImageSpaceAdapter.RadialBlurCenter (P2Float).
    // Hardcoded to exactly this verified set — the same "verified, not assumed, small closed set"
    // posture this file already takes for OMOD's seven leaf interfaces — rather than a generic "any
    // struct shaped like a small vector" rule, which would also match several of these types' own
    // self-referencing Point property (P3Int16's own `Point => this` among them) and recurse
    // forever. Noggog's other siblings (P2Double, P3Double, P3Int, the wrapper types ending in
    // Value or Obj) have zero FO4 usages and stay out on that ground.
    private static readonly HashSet<Type> VectorStructTypes =
    [
        typeof(P3Int16), typeof(P3Float),
        typeof(P2Int), typeof(P2UInt8), typeof(P2Int16),
        typeof(P3UInt8), typeof(P3UInt16), typeof(P2Float),
    ];

    private static bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type);

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

    // This walks only the properties declared on getterInterface and the interfaces it
    // implements/inherits — never a more-derived sibling interface. OMOD's Properties element
    // type, IAObjectModPropertyGetter<T>, declares only Property/Step; the real per-element data
    // lives on 7 separate leaf getter interfaces (IObjectModIntPropertyGetter<T>,
    // IObjectModFloatPropertyGetter<T>, ...), each implementing IAObjectModPropertyGetter<T>
    // rather than the other way around, so none of their own members are ever reached by this
    // walk alone. #360 closes that gap for OMOD specifically — see BuildObjectModPropertyLeafFields.
    // #548 generalizes the same shape for every other Mutagen "A<Name>" abstract Loqui union
    // (ANpcLevel, AQuestAlias, ...) — see BuildAbstractUnionLeafFields for why OMOD's own leaves
    // still need their own hand-picked table (a generic base type with no reflectively-discoverable
    // ClassType of its own) while everything else can be discovered by reflection alone.
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

        if (IsObjectModPropertyBase(getterInterface))
            result.AddRange(BuildObjectModPropertyLeafFields(getterInterface, getterTypeToTable, logger));
        else if (TryGetAbstractUnionLeaves(getterInterface, out var unionLeaves))
            result.AddRange(BuildAbstractUnionLeafFields(
                getterInterface, unionLeaves, getterTypeToTable, depth + 1, logger));

        return result;
    }

    // ── #360: OMOD's Properties element's seven leaf getter interfaces ─────────────────────────
    // Hardcoded to these seven names, not discovered by scanning the assembly for anything else
    // shaped like this: IAObjectModPropertyGetter<T> is, today, the only base Getter interface in
    // the schema whose real per-element payload lives entirely on named sibling leaves it never
    // inherits from (confirmed against the real ObjectMod*Property_Generated.cs sources — the one
    // other generic Getter interface in the Fallout4 assembly, IObjectTemplateGetter<T>, has no
    // such siblings at all). Building a general "discover a base's leaf siblings" mechanism here
    // would be machinery for a second consumer that doesn't exist yet; if one turns up, that
    // ticket can lift a general version out then, against two real call sites instead of one
    // imagined one.
    //
    // #531 pairs each leaf with Mutagen's own ObjectModProperty.ValueType member name (verified
    // against Mutagen.Bethesda.Fallout4/Records/Common Subrecords/ObjectModProperty.cs — Int=0,
    // Float=1, Bool=2, String=3, FormIdInt=4, Enum=5, FormIdFloat=6, reordered here to line up
    // with the getter-interface list rather than the enum's own ordinal order) — the write-side
    // discriminator (see ResolveObjectModPropertyConcreteType below), spelled the same way #360's
    // own read side is extended to expose it (BuildObjectModPropertyLeafFields' `value_type`), not
    // a second scheme. Bare strings, not a reference to one game's enum type, for the same reason
    // the interface names are strings: this stays game-generic (Starfield's own ValueType enum
    // carries the same seven members under its own namespace).
    private static readonly (string InterfaceName, string ValueTypeName)[] ObjectModPropertyLeaves =
    [
        ("IObjectModIntPropertyGetter`1", "Int"),
        ("IObjectModFloatPropertyGetter`1", "Float"),
        ("IObjectModBoolPropertyGetter`1", "Bool"),
        ("IObjectModStringPropertyGetter`1", "String"),
        ("IObjectModEnumPropertyGetter`1", "Enum"),
        ("IObjectModFormLinkIntPropertyGetter`1", "FormIdInt"),
        ("IObjectModFormLinkFloatPropertyGetter`1", "FormIdFloat"),
    ];

    // Mutagen's own name for this member says everything: a reserved padding uint32 on
    // ObjectModStringProperty/ObjectModEnumProperty. xEdit's own definition agrees — the
    // corresponding bytes are wbUnused(3)/wbUnused(2) in wbDefinitionsFO4.pas's
    // wbObjectModProperties, never rendered as a field there either. Excluded here rather than
    // surfaced as a meaningless "unused" column just because both leaves happen to declare it
    // with the same uint32 shape.
    private static readonly HashSet<string> ObjectModPropertyLeafSkip =
        new(StringComparer.OrdinalIgnoreCase) { "Unused" };

    private static bool IsObjectModPropertyBase(Type getterInterface) =>
        getterInterface.IsGenericType &&
        getterInterface.GetGenericTypeDefinition().Name == "IAObjectModPropertyGetter`1";

    // Builds the sparse union of the seven leaves' own members (never Property/Step — those are
    // already reached by the ordinary walk above). Resolved by name off getterInterface's own
    // namespace/assembly rather than a compile-time reference to one game's types, so this still
    // works whichever category's Mutagen assembly is actually loaded (Starfield ships the exact
    // same seven type names under its own namespace).
    //
    // Decision (2026-08-27 triage): group the leaves' own declared members by name. A name every
    // declaring leaf agrees on the CLR type for becomes one typed, sparse sub-field (null on a
    // leaf that lacks it) — `record` (FormLink, FormLinkInt/FormLinkFloat only) and
    // `enum_int_value` (uint, Enum only). A name whose declaring leaves disagree on type becomes
    // one text field via the same FormatWidenedValue the #263 scalar-widen rung already uses —
    // `value` (uint/float/bool/string across six leaves), `value2` (uint/float/bool across
    // three), `function_type` (four distinct FunctionType CLR types across all seven — the
    // triage's own prose counted three; doesn't change the outcome, still collides, still text).
    //
    // #531: every result here now carries a real Apply. BuildTypedLeafUnionField reuses the
    // ordinary per-field write routing #429 already gives every other sub-field. Its widened
    // sibling gets a dedicated applier that resolves the already-constructed concrete object's own
    // declared property type at write time rather than assuming one — the thing #360's read side
    // structurally could not do, since nothing has committed to a concrete type yet there.
    // Read-only was never an end in itself: it was true only because the write
    // path for this element threw regardless (Activator.CreateInstance on the abstract
    // AObjectModProperty<T>), which ApplyListJson's new discriminator-driven resolution now fixes.
    // A plain `result.Add` below also gives the element a `value_type` discriminator sub-field —
    // synthesized here, not one of the seven leaves' own declared members — which is what that
    // resolution reads.
    private static List<SubFieldSpec> BuildObjectModPropertyLeafFields(
        Type baseGetterInterface, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var ns = baseGetterInterface.Namespace;
        var asm = baseGetterInterface.Assembly;
        var args = baseGetterInterface.GetGenericArguments();

        var leaves = new List<(Type LeafType, string ValueTypeName)>();
        foreach (var (interfaceName, valueTypeName) in ObjectModPropertyLeaves)
        {
            var open = asm.GetType($"{ns}.{interfaceName}");
            if (open == null)
            {
                // Same convention as BuildHeaderSchema's own lookup-came-up-empty branches: this
                // runs once per category at schema-build time, not per record, so it's not the
                // per-call accessor-lambda case MEditService/CLAUDE.md's logging section carves
                // silence out for — never seen missing in a real category, but a category whose
                // Mutagen assembly renamed or dropped one of these seven leaves should say so
                // rather than silently lose that leaf's fields.
                logger.LogWarning(
                    "No {LeafName} type found in {Assembly}; OMOD Properties element omits that leaf's fields",
                    interfaceName, asm.GetName().Name);
                continue;
            }
            leaves.Add((open.MakeGenericType(args), valueTypeName));
        }

        var members = leaves
            .SelectMany(leaf => leaf.LeafType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => !ObjectModPropertyLeafSkip.Contains(p.Name))
                .Select(p => (LeafType: leaf.LeafType, Prop: p)))
            .GroupBy(m => ToSnakeCase(m.Prop.Name), StringComparer.OrdinalIgnoreCase);

        var result = new List<SubFieldSpec>();
        foreach (var group in members)
        {
            var list = group.ToList();
            var distinctTypes = list
                .Select(m => Nullable.GetUnderlyingType(m.Prop.PropertyType) ?? m.Prop.PropertyType)
                .Distinct()
                .ToList();

            result.Add(distinctTypes.Count == 1
                ? BuildTypedLeafUnionField(group.Key, list, getterTypeToTable, logger)
                : BuildWidenedLeafUnionField(group.Key, list, logger));
        }

        result.Add(BuildObjectModValueTypeField(leaves));
        return result;
    }

    private const string ObjectModValueTypeDiscriminator = "value_type";

    // #531: the write-side discriminator — which of the seven leaves a Properties element's own
    // JSON should construct. Read: classifies the object's already-concrete runtime type the exact
    // same way every Extract above does (`leafType.IsInstanceOfType`); nothing new is derived here,
    // only exposed. Apply: null, deliberately — this cannot be applied to an *already-constructed*
    // object the way every other sub-field can, because it is what decides which concrete type gets
    // constructed in the first place. ApplyListJson (ResolveObjectModPropertyConcreteType) reads it
    // directly off the incoming JsonElement, before any object exists to apply anything onto.
    private static SubFieldSpec BuildObjectModValueTypeField(List<(Type LeafType, string ValueTypeName)> leaves)
    {
        object? Extract(object obj)
        {
            foreach (var (leafType, valueTypeName) in leaves)
                if (leafType.IsInstanceOfType(obj)) return valueTypeName;
            return null;
        }

        return new(ObjectModValueTypeDiscriminator, "string", Empty,
            [.. leaves.Select(l => l.ValueTypeName)], Extract, Apply: null, AllowsNull: true);
    }

    private static SubFieldSpec BuildTypedLeafUnionField(
        string colName, List<(Type LeafType, PropertyInfo Prop)> members,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var core = Nullable.GetUnderlyingType(members[0].Prop.PropertyType) ?? members[0].Prop.PropertyType;
        var perLeaf = members
            .Select(m => (m.LeafType, Leaf: ClassifyLeaf(m.Prop, core, getterTypeToTable)!))
            .ToList();
        var rep = perLeaf[0].Leaf;
        // Every member in this group shares one CLR property name (that agreement is what put it
        // in the typed union rather than the widened one below), so one applier — resolved off
        // whichever concrete leaf ApplyListJson already constructed — covers every leaf.
        var pName = members[0].Prop.Name;

        object? Extract(object obj)
        {
            foreach (var (leafType, leaf) in perLeaf)
                if (leafType.IsInstanceOfType(obj)) return leaf.Get(obj);
            return null;
        }

        // #531: the same MakeApplier/ApplyFormLinkJson routing ProjectSubField gives every other
        // sub-field (#429) — it resolves the property off the target's own runtime type and answers
        // ApplyOutcome.PropertyNotFound when that type doesn't declare it, which ApplySubFields
        // treats as a silent no-op, exactly what a leaf that lacks this member needs (#532).
        Func<object, JsonElement, ApplyOutcome>? apply = rep.Convert switch
        {
            { } c => MakeApplier(pName, nullable: true, c, logger),
            null when IsFormLink(core) => (obj, val) => ApplyFormLinkJson(obj, val, pName, logger),
            _ => null,
        };

        return new(colName, rep.ApiType, rep.ValidFormKeyTypes, rep.EnumValues, Extract,
            apply,
            AllowsNull: true, IsBitmask: rep.IsBitmask, EnumBitValues: rep.EnumBitValues);
    }

    private static SubFieldSpec BuildWidenedLeafUnionField(
        string colName, List<(Type LeafType, PropertyInfo Prop)> members, ILogger logger)
    {
        var getters = members.Select(m => (m.LeafType, Get: SubGetter(m.Prop))).ToList();
        var pName = members[0].Prop.Name;

        object? Extract(object obj)
        {
            foreach (var (leafType, get) in getters)
                if (leafType.IsInstanceOfType(obj)) return FormatWidenedValue(get(obj));
            return null;
        }

        // #531: unlike the typed union above, these members disagree on CLR type across leaves —
        // that disagreement is why #360 widened them to text on read in the first place. Apply
        // therefore cannot share one converter the way MakeApplier's callers normally do; instead
        // it resolves the target property's own declared type at write time, off whichever
        // concrete leaf ApplyListJson already constructed, and converts into *that*.
        return new(colName, "string", Empty, Empty, Extract, Apply: MakeWidenedApplier(pName, logger), AllowsNull: true);
    }

    /// <summary>
    /// #531/#532: applies one of the widened OMOD leaf union fields (<c>value</c>, <c>value2</c>,
    /// <c>function_type</c>) onto whichever concrete leaf <c>ApplyListJson</c> already resolved.
    ///
    /// <para><see cref="ApplyOutcome.PropertyNotFound"/> when the target object's runtime type
    /// doesn't declare the property at all — an expected, silent outcome one layer up in
    /// <c>ApplySubFields</c> (same convention as <c>MakeApplier</c>): a leaf that lacks this member
    /// is exactly what this shape is for. A JSON <c>null</c> is likewise Applied-as-a-no-op — it
    /// means "this leaf's own Extract had nothing to read back for this member", not a value to
    /// reject.</para>
    ///
    /// <para><see cref="ApplyOutcome.ValueRejected"/> — #532, no longer a silent no-op — when the
    /// property *does* exist but the incoming JSON can't be converted into whatever type it actually
    /// is: <c>ApplySubFields</c> now folds that into a refusal of the whole element/struct write
    /// rather than constructing the right concrete type and then silently dropping a value onto
    /// it.</para>
    /// </summary>
    private static Func<object, JsonElement, ApplyOutcome> MakeWidenedApplier(string pName, ILogger logger)
    {
        var resolve = ResolveProperty(pName);
        return (obj, val) =>
        {
            var rp = resolve(obj.GetType());
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind == JsonValueKind.Null) return ApplyOutcome.Applied;
            var converted = ConvertWidenedJson(val, rp.PropertyType, pName, logger);
            if (converted == null) return ApplyOutcome.ValueRejected;
            rp.SetValue(obj, converted);
            return ApplyOutcome.Applied;
        };
    }

    // The inverse of FormatWidenedValue: a bool leaf's own text is "true"/"false" (that method's
    // own lowercase, JS-idiomatic spelling), an enum leaf's is one of its member names, and every
    // other leaf's is an InvariantCulture-formatted number — so parsing back is exactly as
    // straightforward as formatting was, no heuristics needed, because the property's actual
    // declared type is already known by the time this runs (unlike #360's own read side, nothing
    // here is guessing which leaf it might be — ApplyListJson resolved that before constructing the
    // object this is now applying onto). A freshly-added element with no prior GET to round-trip
    // may instead send a raw JSON number/bool rather than pre-formatted text; both are accepted.
    private static object? ConvertWidenedJson(JsonElement val, Type targetType, string pName, ILogger logger)
    {
        if (targetType == typeof(bool))
        {
            return val.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.String when bool.TryParse(val.GetString(), out var b) => b,
                _ => null,
            };
        }
        if (targetType.IsEnum)
        {
            var s = val.ValueKind == JsonValueKind.String ? val.GetString() : null;
            return s != null && Enum.TryParse(targetType, s, ignoreCase: true, out var e) ? e : null;
        }
        if (targetType == typeof(string))
            return val.ValueKind == JsonValueKind.String ? val.GetString() : val.GetRawText();

        var text = val.ValueKind == JsonValueKind.String ? val.GetString() : val.GetRawText();
        if (text == null) return null;
        try
        {
            return Convert.ChangeType(text, targetType, System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception ex) when (ex is FormatException or OverflowException or InvalidCastException)
        {
            // Same convention as ApplyFormLinkJson's own best-effort catch: a malformed value is a
            // silent no-op to the write path, not a thrown exception, but not silent to the log either.
            if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
            return null;
        }
    }

    // ── #548: general abstract Loqui union ("A<Name>") leaves ──────────────────────────────────
    // Mutagen's "A<Name>" convention: an abstract base (e.g. ANpcLevel, AQuestAlias) whose real
    // per-subclass data lives entirely on concrete classes that inherit *from* it (NpcLevel/
    // PcLevelMult; QuestReferenceAlias/QuestLocationAlias/QuestCollectionAlias) — the same "a plain
    // interface walk from the base alone never reaches it" shape #360 solved narrowly for OMOD's
    // Properties element. Unlike OMOD's own leaves (generic-closed sibling interfaces reachable
    // only via a hand-picked table, because IAObjectModPropertyGetter<T> has no reflectively
    // enumerable closed ClassType of its own — see IsObjectModPropertyBase's own comment), every
    // other abstract union in the FO4 assembly backs its base getter interface with an ordinary
    // non-generic abstract *class* (ANpcLevel_Registration.ClassType, FieldCount == 0), so its
    // concrete leaves are discoverable the same way BuildForCategory's own top-level loop already
    // discovers every schema type: scanning assembly.GetTypes() for what is, and is not, abstract.
    // No per-type interface-name table — the ticket's own instruction to prefer this over a second
    // #360-style table. OMOD's own path stays untouched and alongside this one, rather than forced
    // into one shared abstraction for two genuinely different discovery mechanisms.
    //
    // Each leaf's own member set is built with GetSubFieldInfo — the same per-property dispatch
    // every ordinary (non-union) sub-field already goes through (nested Loqui structs, lists,
    // vector structs, and every scalar/enum/formlink/string shape), not the narrower 4-shape
    // ClassifyLeaf set #360's own OMOD leaves needed (OMOD's 7 leaves are all scalar/enum/formlink/
    // string; AQuestAlias's own leaves are not — QuestReferenceAlias's "Fill Type" is itself
    // several nested Loqui structs, and two of AQuestAlias's three leaves share a list-typed
    // Conditions member). A member whose declaring leaves disagree on shape is omitted — logged,
    // not guessed or crashed on — the same "expose nothing rather than something wrong" rule #263's
    // DamageType/DamageTypeIndexed merge already established for a differently-shaped same-named
    // column (ADR-0026: a confident wrong value is worse than an absent one).

    // Mirrors GetSetterType: reads GetterType off a *concrete* Loqui class's own StaticRegistration,
    // rather than SetterType off a getter interface's.
    private static Type? GetOwnGetterType(Type concreteClass)
    {
        var regProp = concreteClass.GetProperty(
            "StaticRegistration", BindingFlags.Public | BindingFlags.Static);
        var reg = regProp?.GetValue(null);
        return reg?.GetType().GetField("GetterType", BindingFlags.Public | BindingFlags.Static)
            ?.GetValue(null) as Type;
    }

    // Every non-abstract class in the same assembly assignable to abstractSetterType, paired with
    // its own getter interface and its own class Name (the discriminator value — see
    // BuildAbstractUnionDiscriminatorField). IsAssignableFrom is transitive, so a two-level chain
    // (APerkEffect -> APerkEntryPointEffect -> PerkEntryPointModifyValue) is found the same way a
    // one-level one (ANpcLevel -> NpcLevel) is, with no depth-specific handling needed.
    private static List<(Type GetterType, string ClassName)> FindAbstractUnionLeaves(Type abstractSetterType)
    {
        var leaves = new List<(Type, string)>();
        foreach (var t in abstractSetterType.Assembly.GetTypes())
        {
            if (t.IsAbstract || t.IsInterface || !abstractSetterType.IsAssignableFrom(t)) continue;
            if (GetOwnGetterType(t) is { } getter) leaves.Add((getter, t.Name));
        }
        return leaves;
    }

    // #548 review (Finding 1): Condition/ConditionData (CTDA) and AVirtualMachineAdapter (VMAD) are
    // both `public abstract partial class` — structurally identical to ANpcLevel/AQuestAlias — but
    // permanently outside the reflected schema by documented architectural boundary
    // (MEditService/CLAUDE.md:232-235: "VMAD/condition reconstitution survives at the query-service
    // level, Queries/RecordDocumentCodecs, operating on RecordDocument.Body — rejected from the seam
    // itself, same as raw SQL"). The existing exclusion mechanisms (IConditionCodec.
    // IsConditionListField, BuildSchema's own vmadInterfaceType check) gate a *named top-level
    // property* in ReflectColumns, keyed by (declaring type, property name) — neither is reachable
    // from here, where BuildSubSchema's own recursive walk has already descended past any such
    // property into an abstract type with no memory of which field led to it (Condition's own
    // "Data" member specifically: never itself excluded by IsConditionListField, since that check
    // only ever names the *list* fields like Perk.Conditions/Quest.DialogConditions, not a nested
    // struct member two levels beyond one). No existing mechanism reaches this call site, so this
    // is a new, narrow, named exclusion — checked by the resolved concrete Setter type's own name
    // against exactly the two documented boundary types, not a heuristic on the "A<Name>" prefix.
    private static readonly HashSet<string> AbstractUnionExcludedTypeNames =
        new(StringComparer.Ordinal) { "Condition", "ConditionData", "AVirtualMachineAdapter" };

    // getterInterface qualifies when its own Setter type (GetSetterType) is an abstract class,
    // outside the excluded boundary above, with at least one discoverable concrete leaf. OMOD's own
    // IAObjectModPropertyGetter<T> is excluded by BuildSubSchema's own caller order
    // (IsObjectModPropertyBase checked first), not by anything here — its Setter type
    // (AObjectModProperty<T>) is abstract too, but this method is simply never reached for it.
    private static bool TryGetAbstractUnionLeaves(
        Type getterInterface, out List<(Type GetterType, string ClassName)> leaves)
    {
        leaves = [];
        if (GetSetterType(getterInterface) is not { IsAbstract: true } setterType) return false;
        if (AbstractUnionExcludedTypeNames.Contains(setterType.Name)) return false;
        leaves = FindAbstractUnionLeaves(setterType);
        return leaves.Count > 0;
    }

    // Builds the sparse union of every leaf's own members, grouped by snake_case name across
    // leaves. A name only one leaf declares (AQuestAlias's own "location"/"external"/"collection",
    // ...) becomes that leaf's own field, gated to read null off any other leaf. A name several
    // leaves declare (AQuestAlias's own "closest_to_alias"/"conditions" are declared by two of its
    // three leaves) becomes one shared field when every declaring leaf's own GetSubFieldInfo shape
    // agrees, or is omitted when it doesn't (BuildAbstractUnionMemberField). getterInterface's own
    // already-declared members (APerkEffect's own Rank/Priority/Conditions/... — non-zero, unlike
    // ANpcLevel/AQuestAlias) are excluded here: BuildSubSchema's ordinary walk, immediately above
    // this method's own call site, already reaches those directly off the abstract base itself.
    private static List<SubFieldSpec> BuildAbstractUnionLeafFields(
        Type getterInterface,
        List<(Type GetterType, string ClassName)> leaves,
        IReadOnlyDictionary<Type, string> getterTypeToTable,
        int depth,
        ILogger logger)
    {
        var baseMemberNames = GetAllInterfaceProperties(getterInterface)
            .Where(p => !LoquiSkipProps.Contains(p.Name))
            .Select(p => ToSnakeCase(p.Name))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var perLeaf = leaves.Select(leaf => (
            leaf.GetterType,
            leaf.ClassName,
            Members: GetAllInterfaceProperties(leaf.GetterType)
                .Where(p => !LoquiSkipProps.Contains(p.Name) && !baseMemberNames.Contains(ToSnakeCase(p.Name)))
                .GroupBy(p => ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(
                    g => g.Key,
                    g => g.Aggregate((best, cand) =>
                        best.DeclaringType!.IsAssignableFrom(cand.DeclaringType!) ? cand : best),
                    StringComparer.OrdinalIgnoreCase)
            )).ToList();

        var allNames = perLeaf.SelectMany(l => l.Members.Keys).Distinct(StringComparer.OrdinalIgnoreCase);

        var result = new List<SubFieldSpec>();
        foreach (var name in allNames)
        {
            var declaring = perLeaf
                .Where(l => l.Members.ContainsKey(name))
                .Select(l => ((l.GetterType, l.ClassName), Prop: l.Members[name]))
                .ToList();

            if (BuildAbstractUnionMemberField(name, declaring, getterTypeToTable, depth, logger) is { } field)
                result.Add(field);
        }

        // #548 review (Finding 4): defensive, not live — no Mutagen leaf across any game assembly
        // declares a member that snake-cases to "concrete_type" today (checked). But this
        // discriminator is appended unconditionally after every real leaf member into what becomes
        // a last-write-wins Dictionary<string, object?> downstream (ExtractSubObject) — a future
        // leaf that did collide would have its own real data silently replaced by the discriminator,
        // no warning, ADR-0026's failure class. Same "log and omit" rule
        // BuildAbstractUnionMemberField's own shape-disagreement branch already uses, not a new one.
        var discriminator = BuildAbstractUnionDiscriminatorField(leaves);
        if (result.Any(f => f.Name == discriminator.Name))
        {
            logger.LogWarning(
                "Abstract union {Base}'s own {Discriminator} field name collides with a real leaf " +
                "member; omitting the discriminator rather than silently shadowing that member's data",
                getterInterface.Name, AbstractUnionTypeDiscriminator);
        }
        else
        {
            result.Add(discriminator);
        }

        return result;
    }

    private static SubFieldSpec? BuildAbstractUnionMemberField(
        string colName,
        List<((Type GetterType, string ClassName) Leaf, PropertyInfo Prop)> declaring,
        IReadOnlyDictionary<Type, string> getterTypeToTable,
        int depth,
        ILogger logger)
    {
        var perLeafSpecs = declaring
            .Select(d => (d.Leaf, Spec: GetSubFieldInfo(d.Prop, getterTypeToTable, depth, logger)))
            .Where(d => d.Spec != null)
            .ToList();
        if (perLeafSpecs.Count == 0) return null;

        var rep = perLeafSpecs[0].Spec!;
        // Shape agreement, not full structural equality — ApiType plus array-ness plus sub-field
        // count is enough to catch a genuine mismatch (a struct here, a scalar there; two structs
        // with different member counts) without re-deriving GetSubFieldInfo's own dispatch.
        var agree = perLeafSpecs.All(d =>
            d.Spec!.ApiType == rep.ApiType &&
            (d.Spec!.SubFields?.Count ?? -1) == (rep.SubFields?.Count ?? -1) &&
            (d.Spec!.ElementSpec != null) == (rep.ElementSpec != null));
        if (!agree)
        {
            logger.LogWarning(
                "Abstract union member {Member} has disagreeing shapes across leaves {Leaves}; omitted",
                colName, string.Join(", ", declaring.Select(d => d.Leaf.ClassName)));
            return null;
        }

        object? Extract(object obj)
        {
            foreach (var (leaf, spec) in perLeafSpecs)
                if (leaf.GetterType.IsInstanceOfType(obj)) return spec!.Extract(obj);
            return null;
        }

        // rep.Apply already resolves its target property off the object's own runtime type
        // (MakeApplier/ApplyFormLinkJson/the struct- and list-column appliers all do), so it is
        // already safe to reuse unmodified against whichever concrete leaf ApplyListJson/
        // BuildStructColumn's own discriminator resolution already constructed — the same guarantee
        // #531's own OMOD typed-union apply already relies on.
        return rep with { Name = colName, Extract = Extract, AllowsNull = true };
    }

    private const string AbstractUnionTypeDiscriminator = "concrete_type";

    // Read-only: names the concrete leaf class present (e.g. "NpcLevel"/"PcLevelMult",
    // "QuestReferenceAlias"/"QuestLocationAlias"/"QuestCollectionAlias") the same way
    // BuildObjectModValueTypeField already does for OMOD, off the leaf's own class Name rather than
    // an external enum — there is no such enum here, only the CLR type itself. The write side reads
    // this same field back to pick which concrete type to construct
    // (ResolveAbstractUnionConcreteType).
    private static SubFieldSpec BuildAbstractUnionDiscriminatorField(
        List<(Type GetterType, string ClassName)> leaves)
    {
        object? Extract(object obj)
        {
            foreach (var (getterType, className) in leaves)
                if (getterType.IsInstanceOfType(obj)) return className;
            return null;
        }

        return new(AbstractUnionTypeDiscriminator, "string", Empty,
            [.. leaves.Select(l => l.ClassName)], Extract, Apply: null, AllowsNull: true);
    }

    // Write side: resolves the concrete Setter class named by an incoming JSON object's own
    // concrete_type discriminator. Null for any reason (non-object JSON, a missing/unrecognized
    // discriminator, a leaf whose own concrete class no longer resolves) is the caller's signal to
    // refuse rather than guess — the same contract ResolveObjectModPropertyConcreteType already
    // gives ApplyListJson, extended to BuildStructColumn's own single-object case too.
    //
    // #548 review (Finding 3): this used to re-run FindAbstractUnionLeaves's own full
    // assembly.GetTypes() scan (12,914 types for Mutagen.Bethesda.Fallout4.dll) on every call —
    // fine on the read side, where it runs once per abstract type behind GetSchemas' own cache, but
    // this is the write path, called once per array element (ApplyListJson/ApplyListSubFieldJson)
    // with no cache of its own. A leaf's own class always shares its abstract base's namespace (the
    // same fact ResolveObjectModPropertyConcreteType's own `asm.GetType($"{ns}.{interfaceName}")`
    // already leans on for OMOD), so the discriminator string names an O(1) lookup directly —
    // IsAssignableFrom still gates it, so a name that resolves to some unrelated same-namespace type
    // is refused exactly the same as an unrecognized one, never silently accepted.
    private static Type? ResolveAbstractUnionConcreteType(Type abstractSetterType, JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object) return null;
        if (!json.TryGetProperty(AbstractUnionTypeDiscriminator, out var dt) || dt.ValueKind != JsonValueKind.String)
            return null;

        var name = dt.GetString();
        if (string.IsNullOrEmpty(name)) return null;

        var candidate = abstractSetterType.Assembly.GetType($"{abstractSetterType.Namespace}.{name}");
        return candidate is { IsAbstract: false } && abstractSetterType.IsAssignableFrom(candidate)
            ? candidate
            : null;
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

        // #541/#546: a list of vector-struct elements (e.g. IslandData.Vertices, a list of P3Float,
        // or LocationCoordinate.Coordinates, a list of P2Int16). Without this arm, elemMeta below
        // falls through to null (none of these types match the scalar cases in the switch), which
        // makes BuildListColumn drop the whole field the same way ObjectBounds used to drop before
        // #541's other arms — and, worse, BuildListItems's own scalar-element fallback
        // (`result.Add(item)`) would hand a raw boxed vector struct straight to JsonSerializer, which
        // would recurse forever over several of these types' own self-referencing `Point` property.
        if (IsVectorStructType(core))
        {
            var sub = BuildVectorComponentSubFields(core, getterTypeToTable, 0, logger);
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
    // turns a JSON token into the value to write — null means "no generic applier" (a form-link
    // instead gets ApplyFormLinkJson, #429: identically for a top-level column and a sub-field).
    private sealed record LeafSpec(
        string ApiType,
        string DuckDbType,
        string[] ValidFormKeyTypes,
        string[] EnumValues,
        Func<object, object?> Get,
        Func<JsonElement, object?>? Convert,
        bool AllowsNull = false,
        bool IsBitmask = false,
        string[]? EnumBitValues = null,
        bool IsFlagsEnum = false,
        string? ViewDefaultLiteral = null);

    // Classifies the leaf kinds shared by both dispatch paths: primitive, translated-string,
    // enum, form-link. Returns null for list/loqui-struct — the callers handle those.
    private static LeafSpec? ClassifyLeaf(
        PropertyInfo prop, Type core, IReadOnlyDictionary<Type, string> getterTypeToTable)
    {
        if (TryMapPrimitive(core, out var duckDb, out var apiType, out var conv))
        {
            // #413: a value-type primitive is omitted from the document exactly when it equals its
            // CLR default, so a view has to put that default back or the column reads NULL where the
            // wide table held 0/false. A string has no such default — null is the honest answer, and
            // the wide column stored NULL for it too.
            string? defaultLiteral;
            if (core == typeof(string)) defaultLiteral = null;
            else if (core == typeof(bool)) defaultLiteral = "false";
            else defaultLiteral = "0";
            return new(apiType, duckDb, Empty, Empty, SubGetter(prop), conv, ViewDefaultLiteral: defaultLiteral);
        }

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

        // #413: whether the serializer writes this enum as an array of member names, which is a
        // question about the CLR type's [Flags] attribute and nothing else. IsBitmask below answers
        // a different, narrower question (does it have power-of-two members) and gets it wrong for
        // this purpose — a [Flags] enum with no such members still serializes as an array.
        var isFlags = core.GetCustomAttribute<FlagsAttribute>() != null;

        // The default a view falls back to when the serializer omitted the field. A flags enum's
        // rendering is a joined name list, so its default is the empty string — the same thing an
        // empty array renders as, which is what makes absent and "no flags set" indistinguishable
        // by design. A plain enum falls back to whichever member is zero, when one is defined.
        string? defaultLiteral;
        if (isFlags) defaultLiteral = "''";
        else if (Enum.IsDefined(core, Enum.ToObject(core, 0))) defaultLiteral = $"'{Enum.GetName(core, Enum.ToObject(core, 0))}'";
        else defaultLiteral = null;

        return bits != null
            ? new("enum", "BIGINT", Empty, names,
                obj => g(obj) is { } v ? (object?)Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) : null,
                v => Enum.ToObject(core, ReadBitmaskLong(v)),
                IsBitmask: true, EnumBitValues: bits,
                IsFlagsEnum: isFlags, ViewDefaultLiteral: defaultLiteral)
            : new("enum", "VARCHAR", Empty, names,
            obj => g(obj)?.ToString(),
            v => Enum.Parse(core, v.GetString()!, ignoreCase: true),
            IsFlagsEnum: isFlags, ViewDefaultLiteral: defaultLiteral);
    }

    // #531: shared by MakeApplier and MakeWidenedApplier — an applier's target *type* varies per
    // call (a struct/array sub-field's own object can be any of several concrete runtime types,
    // OMOD's seven leaves included), while the property *name* it looks for is fixed for the life
    // of the closure, so the cache is keyed on the former and captured once per the latter.
    private static Func<Type, PropertyInfo?> ResolveProperty(string pName)
    {
        var cache = new ConcurrentDictionary<Type, PropertyInfo?>();
        return t => cache.GetOrAdd(t, tt => tt.GetProperty(pName, BindingFlags.Public | BindingFlags.Instance));
    }

    // The one applier shared by columns and sub-fields: writes a converted JSON value onto a
    // property. Operates on `object`; the column path adapts the IMajorRecord receiver via
    // MakeColumnApplier.
    //
    // #532: used to be an Action that swallowed every way this can fail to write — no such property
    // on the runtime type, a JSON null into a non-nullable column, a converter that threw or (the
    // dead branch this replaces) declined by returning null — and both its column and sub-field
    // callers reported success regardless. Now answers ApplyOutcome so each caller can tell a real
    // refusal (ValueRejected, PropertyNotFound at the top-level-column layer) from the sub-field
    // layer's own expected silent no-op (PropertyNotFound there — see ApplySubFields).
    private static Func<object, JsonElement, ApplyOutcome> MakeApplier(
        string pName, bool nullable, Func<JsonElement, object?> conv, ILogger logger)
    {
        var resolve = ResolveProperty(pName);
        return (obj, val) =>
        {
            var rp = resolve(obj.GetType());
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind == JsonValueKind.Null)
            {
                if (!nullable) return ApplyOutcome.ValueRejected;
                rp.SetValue(obj, null);
                return ApplyOutcome.Applied;
            }

            object? v;
            try
            {
                v = conv(val);
            }
            // #532 finding: none of PrimitiveMap's or ClassifyEnumLeaf's converters ever return null
            // on invalid input — GetInt32/GetBoolean/GetString throw InvalidOperationException for
            // the wrong JSON token kind, Enum.Parse throws ArgumentException for an unrecognised
            // member, and the bitmask branch's long.Parse throws FormatException — so the previous
            // null-return guard below was dead: every declining converter threw straight out of
            // RecordEditService.EditField uncaught instead of triggering it. Same catch list
            // ConvertWidenedJson already uses, widened with ArgumentException/InvalidOperationException
            // for the two dispatch shapes that method doesn't need to cover.
            catch (Exception ex) when (ex is FormatException or OverflowException or InvalidCastException
                                           or ArgumentException or InvalidOperationException)
            {
                if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
                return ApplyOutcome.ValueRejected;
            }

            if (v == null) return ApplyOutcome.ValueRejected;
            rp.SetValue(obj, v);
            return ApplyOutcome.Applied;
        };
    }

    // #532: no longer answers `true` unconditionally — MakeApplier's own ApplyOutcome carries
    // straight through to the column, since a top-level scalar column's failure modes (no such
    // property on the runtime type, a converter that threw or declined) are real refusals at this
    // layer, not the sub-field layer's "shared leaf-union member absent on this concrete leaf"
    // no-op. RecordFieldWriter.TryApply is what translates PropertyNotFound/ValueRejected into their
    // own named refusals.
    private static Func<IMajorRecord, JsonElement, ApplyOutcome> MakeColumnApplier(
        string pName, bool nullable, Func<JsonElement, object?> conv, ILogger logger)
    {
        var applier = MakeApplier(pName, nullable, conv, logger);
        return (record, val) => applier(record, val);
    }

    // #532: no longer answers `true` unconditionally — a FormLink column's own failure modes (an
    // unparseable FormKey, a missing property) now surface as ApplyOutcome.ValueRejected /
    // .PropertyNotFound the same way MakeColumnApplier's scalar siblings do.
    private static Func<IMajorRecord, JsonElement, ApplyOutcome> FormLinkColumnApplier(string pName, ILogger logger) =>
        (record, val) => ApplyFormLinkJson(record, val, pName, logger);

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
            null when IsVectorStructType(core) => BuildVectorSubField(prop, core, colName, getterTypeToTable, depth, logger),
            null when IsListType(core, out var elementType) =>
                BuildListSubField(prop, colName, elementType, getterTypeToTable, logger),
            null when IsLoquiInterface(core) => BuildStructSubField(prop, core, colName, getterTypeToTable, depth, logger),
            _ => null,
        };
    }

    // Projects a shared LeafSpec into a sub-field. Generic leaves (primitive / enum / translated-
    // string) use the shared applier; a form-link (its Convert is null) gets ApplyFormLinkJson —
    // the same routing ProjectColumn gives a top-level FormLink column (#429).
    private static SubFieldSpec ProjectSubField(
        PropertyInfo prop, string colName, Type core, bool nullable, LeafSpec leaf, ILogger logger)
    {
        var pName = prop.Name;
        Func<object, JsonElement, ApplyOutcome>? apply = leaf.Convert switch
        {
            { } c => MakeApplier(pName, nullable, c, logger),
            null when IsFormLink(core) => (obj, val) => ApplyFormLinkJson(obj, val, pName, logger),
            _ => null,
        };
        return new(colName, leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumValues,
            leaf.Get, apply,
            AllowsNull: leaf.AllowsNull, IsBitmask: leaf.IsBitmask, EnumBitValues: leaf.EnumBitValues);
    }

    private static Func<object, object?> SubGetter(PropertyInfo prop) =>
        obj => { try { return prop.GetValue(obj); } catch { return null; } };

    // #532: used to be void, silently discarding every one of its own failure modes (a missing
    // property, an unparseable FormKey string, a JSON value that wasn't even a string) behind a
    // blanket try/catch — both its callers (FormLinkColumnApplier, ProjectSubField) then reported
    // success unconditionally. Now answers ApplyOutcome the same way MakeApplier does, so a top-level
    // FormLink column's own malformed-value write is a real refusal rather than a silent no-op that
    // still re-serializes the record unchanged and calls it applied.
    private static ApplyOutcome ApplyFormLinkJson(object obj, JsonElement val, string pName, ILogger logger)
    {
        try
        {
            var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind == JsonValueKind.Null)
            {
                (rp.GetValue(obj))?.GetType().GetMethod("Clear")?.Invoke(rp.GetValue(obj), []);
                return ApplyOutcome.Applied;
            }
            // GetString() throws InvalidOperationException for any JSON token kind other than string
            // (e.g. a bare number sent for a nullable FormLink column, which ValidateFormLinks itself
            // treats as "no reference" and lets through) — caught below, same as every other
            // conversion failure this method can hit.
            var fkStr = val.GetString();
            if (fkStr == null || !FormKey.TryFactory(fkStr, out var fk)) return ApplyOutcome.ValueRejected;
            var link = rp.GetValue(obj);
            var setTo = link?.GetType().GetMethod("SetTo", [typeof(FormKey)]);
            if (setTo == null) return ApplyOutcome.ValueRejected;
            setTo.Invoke(link, [fk]);
            return ApplyOutcome.Applied;
        }
        catch (Exception ex)
        {
            if (logger.IsEnabled(LogLevel.Trace)) { logger.LogTrace(ex, "Apply skipped for property {Property}", pName); }
            return ApplyOutcome.ValueRejected;
        }
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

    // ── #541/#546: Noggog's small value-vector struct family (see IsVectorStructType) ───────────

    private static readonly string[] VectorComponentNames = ["X", "Y", "Z"];

    // The scalar sub-fields (x/y, or x/y/z for a P3-shaped type) a vector-struct leaf carries,
    // reusing the ordinary GetSubFieldInfo/ClassifyLeaf machinery for the leaf work (byte/short/
    // ushort/int/float -> PrimitiveMap) rather than a bespoke leaf builder — X/Y/Z are ordinary
    // public get/set properties on the vector type itself, so a PropertyInfo for one of them, handed
    // to GetSubFieldInfo the same way any other struct member's PropertyInfo is, gets the same
    // Get/Apply a top-level scalar column would. Deliberately not any vector type's own
    // self-referencing Point property (`P3Int16 Point => this`, and the same shape on P2UInt8/
    // P3UInt8/P3UInt16) — walking it here would recurse forever, which is why this is a fixed
    // name list rather than a generic property walk over the vector type. A P2-shaped type has no
    // "Z" — GetProperty returns null for it, silently skipped by the `continue` below, which is what
    // makes this list produce exactly 2 sub-fields for a P2 type and 3 for a P3 type with no
    // count-specific branch anywhere in this file.
    private static List<SubFieldSpec> BuildVectorComponentSubFields(
        Type vectorType, IReadOnlyDictionary<Type, string> getterTypeToTable, int depth, ILogger logger)
    {
        var result = new List<SubFieldSpec>();
        foreach (var name in VectorComponentNames)
        {
            var componentProp = vectorType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (componentProp == null) continue;
            if (GetSubFieldInfo(componentProp, getterTypeToTable, depth + 1, logger) is { } spec)
                result.Add(spec);
        }
        return result;
    }

    // A vector-struct field nested inside another struct (e.g. ObjectBounds.First/Second, a
    // P3Int16; Cell.Grid.Point, a P2Int) — xEdit shows OBND's six components individually
    // (wbDefinitionsCommon.pas: wbOBND — X1/Y1/Z1/X2/Y2/Z2, not one opaque value), so this mirrors
    // BuildStructSubField's shape rather than treating the vector value as an atomic leaf. Unlike
    // BuildStructSubField (whose nested Loqui structs are read-only, Apply: null), this one is a
    // value type — Get/SetValue on the *enclosing* object is the only way to write it, so Apply
    // builds (or copies) the current boxed value, applies each component onto that same box, then
    // writes the box back onto the enclosing property.
    private static SubFieldSpec? BuildVectorSubField(
        PropertyInfo prop, Type core, string colName,
        IReadOnlyDictionary<Type, string> getterTypeToTable, int depth, ILogger logger)
    {
        var components = BuildVectorComponentSubFields(core, getterTypeToTable, depth, logger);
        if (components.Count == 0) return null;
        var g = SubGetter(prop);
        var pName = prop.Name;
        return new(colName, "struct", Empty, Empty,
            obj => { var v = g(obj); return v == null ? null : ExtractSubObject(v, components); },
            Apply: (obj, val) =>
            {
                if (val.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;
                var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
                if (rp == null) return ApplyOutcome.PropertyNotFound;
                var current = rp.GetValue(obj) ?? Activator.CreateInstance(core)!;
                if (!ApplySubFields(current, val, components)) return ApplyOutcome.ValueRejected;
                if (rp.CanWrite) rp.SetValue(obj, current);
                return ApplyOutcome.Applied;
            },
            SubFields: components);
    }

    // A list nested one level inside a struct (e.g. Destructible.Resistances/Stages) — GetColumnInfo
    // has handled this shape at the top level (BuildListColumn) since the file's beginning; this is
    // its GetSubFieldInfo-side twin, absent until #541 (issue's gap #2). Reuses BuildListColumn's own
    // element-type dispatch (form-link / Loqui-struct / vector) and ApplyListJson for writing, and
    // BuildListItems (not SerializeListItems — see that method's own doc comment for why a sub-field's
    // Extract must stay unserialized) for extraction, so a struct's own list member behaves
    // identically to a top-level array column of the same shape.
    private static List<SubFieldSpec>? BuildListElementSubFields(
        Type elementType, bool isLoqui, bool isVector,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        if (isLoqui) return BuildSubSchema(elementType, getterTypeToTable, logger);
        if (isVector) return BuildVectorComponentSubFields(elementType, getterTypeToTable, 0, logger);
        return null;
    }

    private static SubFieldSpec? BuildListElementSpec(
        Type elementType, bool isFl, IReadOnlyList<SubFieldSpec>? elemSubFields,
        IReadOnlyDictionary<Type, string> getterTypeToTable)
    {
        if (elemSubFields != null)
            return new("", "struct", Empty, Empty, _ => null, Apply: null, SubFields: elemSubFields);
        if (isFl)
        {
            return new("", "formKey", GetFormLinkValidTypes(elementType, getterTypeToTable), Empty,
                _ => null, Apply: null, AllowsNull: true);
        }
        return TryMapPrimitive(elementType, out _, out var elemApiType, out _)
            ? new("", elemApiType, Empty, Empty, _ => null, Apply: null)
            : null;
    }

    private static SubFieldSpec? BuildListSubField(
        PropertyInfo prop, string colName, Type elementType,
        IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var isFl = IsFormLink(elementType);
        var isLoqui = !isFl && IsLoquiInterface(elementType);
        var isVector = !isFl && !isLoqui && IsVectorStructType(elementType);

        var elemSubFields = BuildListElementSubFields(elementType, isLoqui, isVector, getterTypeToTable, logger);

        // Mirrors BuildElementMeta's own branches, but building a SubFieldSpec directly rather than
        // a FieldMetadata — this method's caller (GetSubFieldInfo) needs the reflection-time shape
        // (ElementSpec.ToFieldMetadata() below is what turns it into wire metadata), and elemSubFields
        // above has already done the Loqui/vector element work, so there is nothing to gain from routing
        // through BuildElementMeta's own FieldMetadata output and converting it back.
        var elementSpec = BuildListElementSpec(elementType, isFl, elemSubFields, getterTypeToTable);
        if (elementSpec == null) return null;

        var g = SubGetter(prop);
        var pName = prop.Name;
        Func<object, JsonElement, ApplyOutcome>? apply = isFl || isLoqui || isVector
            ? (obj, json) => ApplyListSubFieldJson(obj, json, pName, isFl, elementType, elemSubFields)
            : null;

        return new(colName, "array", Empty, Empty,
            obj => g(obj) is IEnumerable list ? BuildListItems(list, elementType, elemSubFields) : null,
            apply,
            ElementSpec: elementSpec);
    }

    // ApplyListJson's own sub-field twin: writes a struct/array-nested list's whole value, same
    // atomic-write and refusal rules (CONTEXT.md's Complex field), operating on `object` (the
    // enclosing struct instance) rather than IMajorRecord.
    private static ApplyOutcome ApplyListSubFieldJson(
        object obj, JsonElement json, string pName,
        bool isFl, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (json.ValueKind != JsonValueKind.Array) return ApplyOutcome.ValueRejected;
        var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;

        var listType = rp.PropertyType;
        var newList = Activator.CreateInstance(listType)!;
        var addMethod = listType.GetMethod("Add")!;
        var elemConcreteType = listType.GetGenericArguments()[0];

        foreach (var elem in json.EnumerateArray())
        {
            var concreteType = elemConcreteType;
            if (!isFl && concreteType.IsAbstract)
            {
                if (ResolveAbstractListElementType(concreteType, elem) is not { } resolved)
                    return ApplyOutcome.ListElementTypeUnresolved;
                concreteType = resolved;
            }

            var item = BuildListElement(elem, isFl, elemCore, concreteType, subFields, out var rejected);
            if (rejected) return ApplyOutcome.ValueRejected;
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        if (rp.CanWrite) rp.SetValue(obj, newList);
        return ApplyOutcome.Applied;
    }

    // ── Serialization helpers ─────────────────────────────────────────────────

    private static Dictionary<string, object?> ExtractSubObject(
        object item, IReadOnlyList<SubFieldSpec> fields)
    {
        var dict = new Dictionary<string, object?>();
        foreach (var f in fields) dict[f.Name] = f.Extract(item);
        return dict;
    }

    // The raw object graph for a list's elements — FormLink elements become their FormKey string,
    // struct/vector elements become the same Dictionary<string, object?> ExtractSubObject builds for any
    // other struct, everything else passes through as-is. Deliberately not itself serialized: a
    // top-level array *column* (BuildListColumn) is the one caller that needs a VARCHAR string, and
    // does its own JsonSerializer.Serialize on top of this (SerializeListItems, below). A struct
    // *sub-field* (BuildListSubField) is not that caller — its own Extract composes under the
    // enclosing struct's single JsonSerializer.Serialize (ExtractSubObject's own dictionary), the
    // same way a struct or vector sub-field's Extract already returns a raw Dictionary rather than a
    // pre-serialized string. #541 review finding: BuildListSubField used to call SerializeListItems
    // directly and return its string, which the enclosing struct's own serialize pass then re-encoded as an
    // escaped JSON *string* value instead of a nested array — a round-trip break (ApplyListSubFieldJson
    // requires JsonValueKind.Array, so submitting back exactly what Extract just served was itself
    // refused) and a silent compare-grid diff failure (ConflictClassifier.BuildArrayChildren no-ops
    // on a non-Array JsonElement.Kind) for every struct-nested list, including #541's own two named
    // fields (Destructible.Resistances/Stages) and the real-data case (ActivateParents.Parents).
    private static List<object?> BuildListItems(
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
        return result;
    }

    // BuildListColumn's own caller shape: a top-level array column's Extract returns a VARCHAR
    // string (the DuckDB column type), unlike a struct sub-field's Extract (see BuildListItems above).
    private static string? SerializeListItems(
        IEnumerable items, Type elementType, IReadOnlyList<SubFieldSpec>? subFields) =>
        JsonSerializer.Serialize(BuildListItems(items, elementType, subFields));

    // ── GetColumnInfo ─────────────────────────────────────────────────────────

    private static ColumnInfoResult? GetColumnInfo(
        PropertyInfo prop, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var type = prop.PropertyType;
        var core = Nullable.GetUnderlyingType(type) ?? type;
        var nullable = Nullable.GetUnderlyingType(type) != null || !type.IsValueType;

        return ClassifyLeaf(prop, core, getterTypeToTable) switch
        {
            { } leaf => ProjectColumn(prop, core, nullable, leaf, logger),
            null when IsVectorStructType(core) => BuildVectorColumn(prop, core, getterTypeToTable, logger),
            null when IsListType(core, out var elementType) => BuildListColumn(prop, elementType, getterTypeToTable, logger),
            null when IsLoquiInterface(core) => BuildStructColumn(prop, core, getterTypeToTable, logger),
            _ => null,
        };
    }

    // Projects a shared LeafSpec into a top-level column. A form-link leaf (Convert null) gets
    // ApplyFormLinkJson (#429) — the same routing ProjectSubField gives its sub-field sibling, so a
    // top-level column is no longer the one FormLink shape without a write path.
    private static ColumnInfoResult ProjectColumn(PropertyInfo prop, Type core, bool nullable, LeafSpec leaf, ILogger logger)
    {
        var pName = prop.Name;
        Func<IMajorRecord, JsonElement, ApplyOutcome>? apply = leaf.Convert switch
        {
            { } c => MakeColumnApplier(pName, nullable, c, logger),
            null when IsFormLink(core) => FormLinkColumnApplier(pName, logger),
            _ => null,
        };
        return new(leaf.DuckDbType, r => leaf.Get(r), leaf.ApiType, leaf.ValidFormKeyTypes, leaf.EnumValues,
            apply,
            AllowsNull: leaf.AllowsNull, IsBitmask: leaf.IsBitmask, EnumBitValues: leaf.EnumBitValues,
            IsFlagsEnum: leaf.IsFlagsEnum,
            // A nullable property genuinely can be absent-meaning-null, so it keeps NULL rather than
            // being coalesced to a default it never had.
            ViewDefaultLiteral: nullable ? null : leaf.ViewDefaultLiteral);
    }

    // ── IReadOnlyList<T> ──────────────────────────────────────────────────────

    private static ColumnInfoResult? BuildListColumn(
        PropertyInfo prop, Type elementType, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var isFl = IsFormLink(elementType);
        var isLoqui = !isFl && IsLoquiInterface(elementType);
        // #541/#546: a list of vector-struct elements (IslandData.Vertices, a list of P3Float, or
        // LocationCoordinate.Coordinates, a list of P2Int16) — same three-cases-share-one-shape
        // pattern as GetColumnInfo/GetSubFieldInfo/BuildElementMeta above.
        var isVector = !isFl && !isLoqui && IsVectorStructType(elementType);

        var elemSubFields = BuildListElementSubFields(elementType, isLoqui, isVector, getterTypeToTable, logger);

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
        Func<IMajorRecord, JsonElement, ApplyOutcome>? apply = isFl || isLoqui || isVector
            ? (record, json) => ApplyListJson(record, json, pName, isFl, elementType, elemSubFields)
            : null;

        return new("VARCHAR", Extractor, "array", Empty, Empty, apply,
            ElementMeta: elemMeta);
    }

    /// <summary>
    /// Replaces an array field's whole value. #503: answers <see cref="ApplyOutcome.ValueRejected"/>
    /// for anything that is not array-shaped — typically the bare value of a single element, which is
    /// what the record editor used to send for a per-element edit. An array field is written as one
    /// atomic value (CONTEXT.md), so there is no sensible merge to perform here and no way to guess
    /// where a lone element belongs; the caller refuses instead, which is the difference between
    /// "your edit was rejected" and #503's original "your edit reported success and vanished".
    ///
    /// <para>#531: the same refusal-not-silent-drop rule extends one level in, to an individual
    /// element, when the list's own element type is abstract (OMOD's <c>AObjectModProperty&lt;T&gt;</c>
    /// today — <see cref="IsListType"/>'s Getter-side element type is never abstract itself, only the
    /// mutable Setter list's own generic argument can be). Which concrete leaf an element is depends
    /// on that element's own data, so it is resolved per element from the payload
    /// (<see cref="ResolveAbstractListElementType"/>) rather than assumed once for the whole field.
    /// Unresolvable — no known discriminator scheme for this abstract type, or a discriminator value
    /// this scheme doesn't recognise — answers <see cref="ApplyOutcome.ListElementTypeUnresolved"/>
    /// immediately, before <c>newList</c> is ever attached to <paramref name="record"/>, so a
    /// partially-abstract array can never leave one element applied and the rest silently missing.
    /// Its own outcome value rather than <c>ValueRejected</c> because the fix is different (name a
    /// discriminator, not resend a differently-shaped value) and, since #532, because the two are no
    /// longer reliably tellable apart from the value's shape alone — see the next paragraph.</para>
    ///
    /// <para>#532: the same "before <c>newList</c> is ever attached" guarantee now also covers a
    /// well-formed element whose own sub-field value was declined (<see cref="ApplySubFields"/>'s
    /// <c>ValueRejected</c> fold, as opposed to a sub-field simply not applying to this element's own
    /// concrete leaf, which stays silent) — a struct-array write with one bad member refuses the whole
    /// array rather than landing every other element and dropping the bad one. This is exactly why
    /// <see cref="ApplyOutcome.ListElementTypeUnresolved"/> had to become its own outcome rather than
    /// staying inferred from "a rejection, and the value happens to be a genuine JSON array"
    /// (<c>RecordEditService.RefuseFieldOutcome</c>'s old heuristic): once a well-typed element could
    /// also fail this way, that inference started misclassifying a declined sub-field value as an
    /// unresolved element type.</para>
    /// </summary>
    private static ApplyOutcome ApplyListJson(
        IMajorRecord record, JsonElement json, string pName,
        bool isFl, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (json.ValueKind != JsonValueKind.Array) return ApplyOutcome.ValueRejected;
        var rp = record.GetType()
            .GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;

        var listType = rp.PropertyType;
        var newList = Activator.CreateInstance(listType)!;
        var addMethod = listType.GetMethod("Add")!;

        // Derive the concrete element type from the mutable list's own generic argument, not from
        // GetSetterType — which returns the setter *interface* (e.g. IRankPlacement), not the
        // instantiable concrete class (RankPlacement). A FormLink list's own generic argument here
        // is never used (BuildListElement's isFl branch works from elemCore instead), so it is safe
        // to compute unconditionally.
        var elemConcreteType = listType.GetGenericArguments()[0];

        foreach (var elem in json.EnumerateArray())
        {
            var concreteType = elemConcreteType;
            if (!isFl && concreteType.IsAbstract)
            {
                if (ResolveAbstractListElementType(concreteType, elem) is not { } resolved)
                    return ApplyOutcome.ListElementTypeUnresolved;
                concreteType = resolved;
            }

            var item = BuildListElement(elem, isFl, elemCore, concreteType, subFields, out var rejected);
            if (rejected) return ApplyOutcome.ValueRejected;
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        rp.SetValue(record, newList);
        return ApplyOutcome.Applied;
    }

    // #531: OMOD's own Properties element has its own discriminator scheme
    // (ResolveObjectModPropertyConcreteType, off AObjectModProperty<T>'s generic-closed shape) —
    // checked first and kept as its own case, the same posture #360's own IsObjectModPropertyBase
    // takes, rather than folded into the general lookup below (OMOD's leaves are not reflectively
    // discoverable off their own generic base the way every other abstract union's are).
    //
    // #548: every other abstract list-element type (AQuestAlias, ...) resolves generally, off the
    // same concrete_type discriminator BuildAbstractUnionDiscriminatorField exposes on read. Either
    // way, an abstract-element field with no scheme that resolves — a missing/unrecognized
    // discriminator, or a genuinely unknown shape — falls straight through to null, which
    // ApplyListJson/ApplyListSubFieldJson turn into a refusal rather than a guess or a throw.
    private static Type? ResolveAbstractListElementType(Type elemConcreteType, JsonElement elem) =>
        elemConcreteType.IsGenericType && elemConcreteType.GetGenericTypeDefinition().Name == "AObjectModProperty`1"
            ? ResolveObjectModPropertyConcreteType(elemConcreteType, elem)
            : ResolveAbstractUnionConcreteType(elemConcreteType, elem);

    // Reads the `value_type` discriminator BuildObjectModValueTypeField exposes on read and maps it
    // back to the one leaf getter interface that owns it (ObjectModPropertyLeaves — the exact same
    // table BuildObjectModPropertyLeafFields resolves from, so read and write cannot name the seven
    // leaves differently), then to that interface's own concrete Setter class (GetSetterType) closed
    // over elemConcreteType's own T. Null for any reason — missing/unrecognized discriminator, a
    // leaf interface or setter type that no longer resolves — is exactly the caller's one signal to
    // refuse rather than guess.
    private static Type? ResolveObjectModPropertyConcreteType(Type elemConcreteType, JsonElement elem)
    {
        if (!elem.TryGetProperty(ObjectModValueTypeDiscriminator, out var vt) || vt.ValueKind != JsonValueKind.String)
            return null;

        var match = Array.Find(ObjectModPropertyLeaves, l => l.ValueTypeName == vt.GetString());
        if (match.InterfaceName == null) return null;

        var typeArgs = elemConcreteType.GetGenericArguments();
        var getterOpen = elemConcreteType.Assembly.GetType($"{elemConcreteType.Namespace}.{match.InterfaceName}");
        if (getterOpen == null) return null;

        // GetSetterType's own ClassType field answers with the *open* generic Setter class (e.g.
        // ObjectModIntProperty<T>, T unbound) even off a closed getter interface — confirmed against
        // real Fallout4 types, not assumed — so closing it over elemConcreteType's own T is this
        // method's own job, not GetSetterType's.
        var setterType = GetSetterType(getterOpen.MakeGenericType(typeArgs));
        if (setterType is not { IsAbstract: false }) return null;
        return setterType.IsGenericTypeDefinition ? setterType.MakeGenericType(typeArgs) : setterType;
    }

    private static object? BuildListElement(
        JsonElement elem, bool isFl, Type elemCore, Type elemConcreteType, IReadOnlyList<SubFieldSpec>? subFields,
        out bool rejected)
    {
        rejected = false;
        if (isFl)
        {
            var fkStr = elem.GetString();
            if (fkStr == null || !FormKey.TryFactory(fkStr, out var fk)) return null;
            var flType = typeof(FormLink<>).MakeGenericType(elemCore.GetGenericArguments()[0]);
            return Activator.CreateInstance(flType, fk);
        }

        var elemObj = Activator.CreateInstance(elemConcreteType)!;
        rejected = !ApplySubFields(elemObj, elem, subFields!);
        return elemObj;
    }

    /// <summary>
    /// Applies every sub-field's own value onto <paramref name="target"/>, folding each member's
    /// <see cref="ApplyOutcome"/> into one whole-object result for the struct/array-element caller.
    ///
    /// <para>#531: a sub-field can be genuinely read-only (e.g. OMOD's own <c>value_type</c>
    /// discriminator, which decides the object's concrete type rather than being set on it) or absent
    /// from the incoming JSON — both skipped, not applied at all.</para>
    ///
    /// <para>#532: of the members that <i>are</i> applied, <see cref="ApplyOutcome.PropertyNotFound"/>
    /// stays a silent no-op here — a sub-field shared across several concrete sibling leaf types that
    /// don't all declare it (OMOD's own sparse leaf-union: <c>value</c>, <c>value2</c>, <c>record</c>,
    /// <c>enum_int_value</c>, <c>function_type</c>) is *expected* to miss on some of them, by design,
    /// every time an element of that shape round-trips. Only <see cref="ApplyOutcome.ValueRejected"/>
    /// — the property exists on this concrete leaf but the value itself couldn't be converted — fails
    /// the whole object, which <see cref="BuildListElement"/> and the struct column's own apply both
    /// turn into a refusal of the entire array/struct write before it ever reaches the record
    /// (<see cref="ApplyListJson"/>'s "before <c>newList</c> is attached" guarantee, extended one
    /// level in).</para>
    /// </summary>
    private static bool ApplySubFields(object target, JsonElement json, IReadOnlyList<SubFieldSpec> subFields)
    {
        var allAccepted = true;
        foreach (var sf in subFields)
        {
            if (sf.Apply is not { } apply || !json.TryGetProperty(sf.Name, out var sfVal)) continue;
            if (apply(target, sfVal) == ApplyOutcome.ValueRejected) allAccepted = false;
        }
        return allAccepted;
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
        Func<IMajorRecord, JsonElement, ApplyOutcome>? apply = null;
        if (setterType != null)
        {
            // #503: the struct half of ApplyListJson's own shape guard — a struct field is written as
            // one atomic value, so a bare member value (what a per-member edit used to send) is
            // refused rather than silently returning while the write path reported success.
            //
            // #532: the same refusal now also covers a well-formed object whose own member value was
            // declined (ApplySubFields' ValueRejected fold) — SetValue is skipped in that case too, so
            // a struct write with one bad member never attaches its partially-built value to the
            // record, matching ApplyListJson's own "before newList is attached" guarantee.
            //
            // #548: setterType is abstract for an abstract Loqui union (ANpcLevel, ...) —
            // Activator.CreateInstance would throw MissingMethodException on it directly, so the
            // concrete type is resolved off the incoming JSON's own discriminator first, refusing
            // (ValueRejected) rather than crashing when it can't be. Only reused when the record's
            // existing value is already that same concrete type — switching concrete leaf (NpcLevel
            // to PcLevelMult) cannot reuse the old object, so it constructs fresh instead.
            apply = (record, json) =>
            {
                if (json.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;

                var concreteType = setterType;
                if (setterType.IsAbstract)
                {
                    if (ResolveAbstractUnionConcreteType(setterType, json) is not { } resolved)
                        return ApplyOutcome.ValueRejected;
                    concreteType = resolved;
                }

                var rp = record.GetType()
                    .GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;
                var existing = rp.GetValue(record);
                var obj = concreteType.IsInstanceOfType(existing) ? existing! : Activator.CreateInstance(concreteType)!;
                if (!ApplySubFields(obj, json, subFields)) return ApplyOutcome.ValueRejected;
                if (rp.CanWrite) rp.SetValue(record, obj);
                return ApplyOutcome.Applied;
            };
        }

        return new("VARCHAR", Extractor, "struct", Empty, Empty, apply,
            SubFieldMetas: subFieldMetas);
    }

    // A vector-struct field at the record's own top level (e.g. IslandData.Min/Max,
    // Placed*.Position/Rotation, MaterialObject.ProjectionVector, ImageSpaceAdapter.RadialBlurCenter)
    // — BuildStructColumn's twin for Noggog's small value-vector structs (see IsVectorStructType),
    // unlike which there is no separate Getter/Setter split to resolve: `core` here already is the
    // concrete vector struct on both sides, so this can always construct and write one,
    // unconditionally.
    //
    // #541: making Position reachable here for the *Placed family specifically re-opens a hazard
    // RecordEditService.RefuseIfContainmentField's own doc comment names explicitly — placement's
    // Position is mirrored into the `placement` side table (PlacementWalker) with no write-time
    // re-derivation. That refusal is extended in the same change that lands this method; see its own
    // doc comment for the guard.
    private static ColumnInfoResult? BuildVectorColumn(
        PropertyInfo prop, Type core, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var components = BuildVectorComponentSubFields(core, getterTypeToTable, 0, logger);
        if (components.Count == 0) return null;

        var subFieldMetas = components.ConvertAll(s => s.ToFieldMetadata());

        object? Extractor(IMajorRecordGetter r)
        {
            var obj = TryGet(r, prop);
            return obj == null ? null
                : JsonSerializer.Serialize(ExtractSubObject(obj, components));
        }

        var pName = prop.Name;
        return new("VARCHAR", Extractor, "struct", Empty, Empty,
            (record, json) =>
            {
                if (json.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;
                var rp = record.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;
                var obj = rp.GetValue(record) ?? Activator.CreateInstance(core)!;
                if (!ApplySubFields(obj, json, components)) return ApplyOutcome.ValueRejected;
                if (rp.CanWrite) rp.SetValue(record, obj);
                return ApplyOutcome.Applied;
            },
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

/// <summary>
/// Thrown by <see cref="ISchemaReflector.GetSchemas"/> when a game release's backing Mutagen
/// record-type assembly is not referenced by this build (#445) — e.g. requesting Skyrim before
/// #423 adds <c>Mutagen.Bethesda.Skyrim</c>. Distinguishes "this release isn't compiled in" from
/// Mutagen's own <see cref="FileNotFoundException"/>, which is not an actionable message for a
/// caller. <see cref="ISchemaReflector.IsSupported"/> is the non-throwing check discovery should
/// use instead of catching this.
/// </summary>
public sealed class UnsupportedGameReleaseException : Exception
{
    // RCS1194: the three standard exception constructors, for well-behaved rethrow/serialization
    // callers generally — not how SchemaReflector itself throws this (see the release-based
    // constructor below), which builds a specific, actionable message naming the missing assembly.
    public UnsupportedGameReleaseException()
    {
    }

    public UnsupportedGameReleaseException(string message) : base(message)
    {
    }

    public UnsupportedGameReleaseException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal UnsupportedGameReleaseException(GameRelease release, string assemblyName)
        : base($"Game release '{release}' is not supported by this build: the Mutagen assembly '{assemblyName}' is not referenced.")
    {
        Release = release;
    }

    public GameRelease Release { get; }
}
