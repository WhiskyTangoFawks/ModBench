using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using MEditService.Core.Queries;
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

    // Phase 16: placed references (refr/achr) are indexed as normal records so the
    // worldspace tree, record editor, and agent queries are uniform DuckDB reads; their
    // cell parentage lives in the `placement` side table. Landscape/navmesh and the rare
    // projectile/hazard placements stay excluded — they aren't standard editable refs.
    private static readonly HashSet<string> _excludedTables = new(StringComparer.OrdinalIgnoreCase)
    {
        "land", "navm", "navi",
        "pgre", "pmis", "parw", "pbar", "pbea",
        "pcon", "pfla", "pfo2", "phzd",
    };

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

        var seenTables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var discovered = new List<(string tableName, Type getterType)>();

        foreach (var type in assembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface) continue;
            if (!majorRecordGetterType.IsAssignableFrom(type)) continue;

            var grupField = type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static);
            if (grupField == null) continue;

            var recordType = (RecordType)grupField.GetValue(null)!;
            var tableName = recordType.Type.ToLowerInvariant();

            if (_excludedTables.Contains(tableName)) continue;
            if (!seenTables.Add(tableName)) continue;

            var getterInterface = assembly.GetType($"Mutagen.Bethesda.{category}.I{type.Name}Getter")!;

            discovered.Add((tableName, getterInterface));
        }

        var getterTypeToTable = discovered.ToDictionary(d => d.getterType, d => d.tableName);

        var modType = assembly.GetType($"Mutagen.Bethesda.{category}.{category}Mod");

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            var schema = BuildSchema(tableName, getterType, getterTypeToTable, logger);
            var (addNew, remove, addExisting) = BuildLifecycleDelegates(modType, getterType);

            schemas[tableName] = addNew == null ? schema : new RecordTableSchema
            {
                TableName = schema.TableName,
                RecordType = schema.RecordType,
                RecordColumns = schema.RecordColumns,
                AddNew = addNew,
                Remove = remove,
                AddExisting = addExisting,
            };
        }

        return new GameSchemaCache(schemas, getterTypeToTable);
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

        void addNew(IMod mod, FormKey fk)
        {
            var group = (IGroup)groupProp.GetValue(mod)!;
            group.AddNew(fk);
        }
        void addExisting(IMod mod, IMajorRecord rec)
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

        return (addNew, remove, addExisting);
    }

    private static RecordTableSchema BuildSchema(
        string tableName, Type getterType, IReadOnlyDictionary<Type, string> getterTypeToTable, ILogger logger)
    {
        var baseSkip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl",
            "MajorRecordFlagsRaw", "SubgraphRevision"
        };

        var grouped = GetAllInterfaceProperties(getterType)
            .Where(p => !baseSkip.Contains(p.Name))
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

        return new RecordTableSchema
        {
            TableName = tableName,
            RecordType = getterType,
            RecordColumns = columns
        };
    }

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

    private static readonly string[] _empty = [];

    private static readonly HashSet<string> _loquiSkipProps =
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
            ? [tn] : _empty;
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

    private static List<SubFieldSpec> BuildSubSchema(
        Type getterInterface,
        IReadOnlyDictionary<Type, string> getterTypeToTable,
        ILogger logger,
        int depth = 0)
    {
        if (depth > 3) return [];

        var grouped = GetAllInterfaceProperties(getterInterface)
            .Where(p => !_loquiSkipProps.Contains(p.Name))
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
                GetFormLinkValidTypes(core, getterTypeToTable), _empty,
                IsSortable: true, AllowsNull: true);
        }

        if (IsLoquiInterface(core))
        {
            var sub = BuildSubSchema(core, getterTypeToTable, logger);
            return sub.Count == 0
                ? null
                : new FieldMetadata("", "struct", false, _empty, _empty,
                Fields: [.. sub.Select(s => s.ToFieldMetadata())]);
        }

        if (core == typeof(float))
            return new("", "float", false, _empty, _empty);
        if (core == typeof(string) || IsTranslatedString(core))
            return new("", "string", false, _empty, _empty);
        return _integerTypes.Contains(core) ? new("", "int", false, _empty, _empty) : null;
    }

    private static readonly HashSet<Type> _integerTypes =
    [
        typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(long), typeof(ulong),
    ];

    // ── Primitive type dispatch shared by GetColumnInfo and GetSubFieldInfo ─────

    private static readonly Dictionary<Type, (string DuckDbType, string ApiType, Func<JsonElement, object?> Converter)> _primitiveMap = new()
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
        if (_primitiveMap.TryGetValue(core, out var mapped))
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
            return new(apiType, duckDb, _empty, _empty, SubGetter(prop), conv);

        if (IsTranslatedString(core))
        {
            var g = SubGetter(prop);
            return new("string", "VARCHAR", _empty, _empty,
                obj => { try { return (g(obj) as ITranslatedStringGetter)?.String; } catch { return null; } }, // Stryker disable once Block: silent accessor lambda — lookup-backed strings throw when game strings files are absent (see MEditService CLAUDE.md)
                v => new TranslatedString(Language.English, v.GetString()));
        }

        if (core.IsEnum)
            return ClassifyEnumLeaf(prop, core);

        if (IsFormLink(core))
        {
            var g = SubGetter(prop);
            return new("formKey", "VARCHAR", GetFormLinkValidTypes(core, getterTypeToTable), _empty,
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
            ? new("enum", "BIGINT", _empty, names,
                obj => g(obj) is { } v ? (object?)Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) : null,
                v => Enum.ToObject(core, ReadBitmaskLong(v)),
                IsBitmask: true, EnumBitValues: bits)
            : new("enum", "VARCHAR", _empty, names,
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

        if (ClassifyLeaf(prop, core, getterTypeToTable) is { } leaf)
            return ProjectSubField(prop, colName, core, nullable, leaf, logger);

        return IsLoquiInterface(core) ? BuildStructSubField(prop, core, colName, getterTypeToTable, depth, logger) : null;
    }

    // Projects a shared LeafSpec into a sub-field. Generic leaves (primitive / enum / translated-
    // string) use the shared applier; a form-link (its Convert is null) gets ApplyFormLinkJson —
    // the one place a sub-field form-link differs from its read-only column counterpart.
    private static SubFieldSpec ProjectSubField(
        PropertyInfo prop, string colName, Type core, bool nullable, LeafSpec leaf, ILogger logger)
    {
        var pName = prop.Name;
        Action<object, JsonElement>? apply;
        if (leaf.Convert is { } c)
            apply = MakeApplier(pName, nullable, c);
        else apply = IsFormLink(core) ? ((obj, val) => ApplyFormLinkJson(obj, val, pName, logger)) : null;
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
        return new(colName, "struct", _empty, _empty,
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

        if (ClassifyLeaf(prop, core, getterTypeToTable) is { } leaf)
            return ProjectColumn(prop, nullable, leaf);

        if (IsListType(core, out var elementType))
            return BuildListColumn(prop, elementType, getterTypeToTable, logger);

        return IsLoquiInterface(core) ? BuildStructColumn(prop, core, getterTypeToTable, logger) : null;
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

        object? extractor(IMajorRecordGetter r)
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

        return new("VARCHAR", extractor, "array", _empty, _empty, apply,
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

        object? extractor(IMajorRecordGetter r)
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

        return new("VARCHAR", extractor, "struct", _empty, _empty, apply,
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
