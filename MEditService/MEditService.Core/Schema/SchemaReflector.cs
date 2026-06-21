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

public sealed class SchemaReflector : ISchemaReflector
{
    private readonly ILogger _logger;

    public SchemaReflector(ILogger<SchemaReflector>? logger = null)
    {
        _logger = logger ?? NullLogger<SchemaReflector>.Instance; // Stryker disable once NullCoalescing: logger init; only usage is a defensive LogTrace in catch — unreachable from tests without artificial exception injection
    }

    private static readonly HashSet<string> _excludedTables = new(StringComparer.OrdinalIgnoreCase)
    {
        "refr", "achr",
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
        var iGroupOpenGeneric = typeof(IGroup<>);

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            var schema = BuildSchema(tableName, getterType, getterTypeToTable, logger);

            Action<IMod, FormKey>? addNew = null;
            Func<IMod, FormKey, bool>? remove = null;
            Action<IMod, IMajorRecord>? addExisting = null;
            if (modType != null)
            {
                var setterType = GetSetterType(getterType);
                if (setterType != null)
                {
                    var targetGroupType = iGroupOpenGeneric.MakeGenericType(setterType);
                    var groupProp = modType
                        .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                        .FirstOrDefault(p => targetGroupType.IsAssignableFrom(p.PropertyType));
                    if (groupProp != null)
                    {
                        addNew = (mod, fk) =>
                        {
                            var group = (IGroup)groupProp.GetValue(mod)!;
                            group.AddNew(fk);
                        };
                        addExisting = (mod, rec) =>
                        {
                            var group = (IGroup)groupProp.GetValue(mod)!;
                            group.AddUntyped(rec);
                        };
                        // Remove(FormKey) is on IGroup<T>, not the non-generic IGroup; resolve MethodInfo
                        // once at schema-build time and close over it to avoid per-call reflection.
                        var removeMethod = targetGroupType
                            .GetMethod("Remove", BindingFlags.Public | BindingFlags.Instance, [typeof(FormKey)]);
                        if (removeMethod != null)
                            remove = (mod, fk) =>
                            {
                                var grp = groupProp.GetValue(mod)!;
                                return removeMethod.Invoke(grp, [fk]) is true;
                            };
                    }
                }
            }

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
            // Array elements are commonly sparse (a "Null" slot is a tolerated placeholder, not a
            // data error) — getter interfaces can't statically distinguish this from a non-nullable
            // scalar anyway (see IsNullableFormLink), so default permissive here regardless.
            return new FieldMetadata("", "formKey", false,
                GetFormLinkValidTypes(core, getterTypeToTable), _empty,
                IsSortable: true, AllowsNull: true);

        if (IsLoquiInterface(core))
        {
            var sub = BuildSubSchema(core, getterTypeToTable, logger);
            if (sub.Count == 0) return null;
            return new FieldMetadata("", "struct", false, _empty, _empty,
                Fields: sub.Select(s => s.ToFieldMetadata()).ToList());
        }

        if (core == typeof(float))
            return new("", "float", false, _empty, _empty);
        if (core == typeof(string) || IsTranslatedString(core))
            return new("", "string", false, _empty, _empty);
        if (core == typeof(byte) || core == typeof(sbyte) ||
            core == typeof(short) || core == typeof(ushort) ||
            core == typeof(int) || core == typeof(uint) ||
            core == typeof(long) || core == typeof(ulong))
            return new("", "int", false, _empty, _empty);
        return null;
    }

    // ── Primitive type dispatch shared by GetColumnInfo and GetSubFieldInfo ─────

    private static bool TryMapPrimitive(
        Type core,
        out string duckDbType,
        out string apiType,
        out Func<JsonElement, object?> converter)
    {
        if (core == typeof(bool))
        { duckDbType = "BOOLEAN"; apiType = "bool"; converter = v => (object)v.GetBoolean(); return true; }
        if (core == typeof(byte))
        { duckDbType = "INTEGER"; apiType = "int"; converter = v => (object)(byte)v.GetInt32(); return true; }
        if (core == typeof(sbyte))
        { duckDbType = "INTEGER"; apiType = "int"; converter = v => (object)(sbyte)v.GetInt32(); return true; }
        if (core == typeof(short))
        { duckDbType = "INTEGER"; apiType = "int"; converter = v => (object)(short)v.GetInt32(); return true; }
        if (core == typeof(ushort))
        { duckDbType = "INTEGER"; apiType = "int"; converter = v => (object)(ushort)v.GetInt32(); return true; }
        if (core == typeof(int))
        { duckDbType = "INTEGER"; apiType = "int"; converter = v => (object)v.GetInt32(); return true; }
        if (core == typeof(uint))
        { duckDbType = "INTEGER"; apiType = "int"; converter = v => (object)v.GetUInt32(); return true; }
        if (core == typeof(ulong))
        { duckDbType = "BIGINT"; apiType = "int"; converter = v => (object)v.GetUInt64(); return true; }
        if (core == typeof(float))
        { duckDbType = "FLOAT"; apiType = "float"; converter = v => (object)v.GetSingle(); return true; }
        if (core == typeof(string))
        { duckDbType = "VARCHAR"; apiType = "string"; converter = v => v.GetString(); return true; }
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
        var pName = prop.Name;
        var colName = ToSnakeCase(pName);

        Func<object, object?> Getter() =>
            obj => { try { return prop.GetValue(obj); } catch { return null; } };

        Action<object, JsonElement> Applier(Func<JsonElement, object?> conv)
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

        if (TryMapPrimitive(core, out _, out var primApiType, out var primConv))
            return new(colName, primApiType, _empty, _empty, Getter(), Applier(primConv));

        if (IsTranslatedString(core))
        {
            var g = Getter();
            return new(colName, "string", _empty, _empty,
                obj => { try { return (g(obj) as ITranslatedStringGetter)?.String; } catch { return null; } },
                Applier(v => new TranslatedString(Language.English, v.GetString())));
        }

        if (core.IsEnum)
        {
            var g = Getter();
            var (names, bits) = GetEnumMeta(core);
            if (bits != null)
                return new(colName, "enum", _empty, names,
                    obj => g(obj) is { } v ? (object?)Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) : null,
                    Applier(v => Enum.ToObject(core, ReadBitmaskLong(v))),
                    IsBitmask: true, EnumBitValues: bits);
            return new(colName, "enum", _empty, names,
                obj => g(obj)?.ToString(),
                Applier(v => Enum.Parse(core, v.GetString() ?? "", ignoreCase: true)));
        }

        if (IsFormLink(core))
        {
            var g = Getter();
            Action<object, JsonElement> flApply = (obj, val) =>
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
            };
            return new(colName, "formKey", GetFormLinkValidTypes(core, getterTypeToTable), _empty,
                obj => (g(obj) as IFormLinkGetter)?.FormKeyNullable?.ToString(),
                flApply, AllowsNull: IsNullableFormLink(core));
        }

        if (IsLoquiInterface(core))
        {
            var sub = BuildSubSchema(core, getterTypeToTable, logger, depth);
            if (sub.Count == 0) return null;
            var g = Getter();
            return new(colName, "struct", _empty, _empty,
                obj => { var v = g(obj); return v == null ? null : ExtractSubObject(v, sub); },
                Apply: null,
                SubFields: sub);
        }

        return null;
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
        var pName = prop.Name;

        Action<IMajorRecord, JsonElement> MakeApply(Func<JsonElement, object?> conv)
        {
            var cache = new ConcurrentDictionary<Type, PropertyInfo?>();
            return (record, value) =>
            {
                var rp = cache.GetOrAdd(record.GetType(), t =>
                    t.GetProperty(pName, BindingFlags.Public | BindingFlags.Instance))!;
                if (value.ValueKind == JsonValueKind.Null)
                {
                    if (nullable) rp.SetValue(record, null);
                    return;
                }
                var v = conv(value);
                if (v != null) rp.SetValue(record, v);
            };
        }

        if (TryMapPrimitive(core, out var primDuckDb, out var primApiType, out var primConv))
            return new(primDuckDb, r => TryGet(r, prop), primApiType, _empty, _empty,
                MakeApply(primConv));

        if (IsTranslatedString(core))
            return new("VARCHAR",
                r =>
                {
                    try { return (TryGet(r, prop) as ITranslatedStringGetter)?.String; } // Stryker disable once Block: per-call accessor lambda stays silent per MEditService CLAUDE.md; lookup-backed strings throw when game strings files are absent
                    catch { return null; }
                },
                "string", _empty, _empty,
                MakeApply(v => new TranslatedString(Language.English, v.GetString())));

        if (core.IsEnum)
        {
            var (names, bits) = GetEnumMeta(core);
            if (bits != null)
                return new("BIGINT",
                    r => TryGet(r, prop) is { } v ? (object?)Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) : null,
                    "enum", _empty, names,
                    MakeApply(v => Enum.ToObject(core, ReadBitmaskLong(v))),
                    IsBitmask: true, EnumBitValues: bits);
            return new("VARCHAR", r => TryGet(r, prop)?.ToString(), "enum", _empty, names,
                MakeApply(v => Enum.Parse(core, v.GetString()!, ignoreCase: true)));
        }

        if (IsFormLink(core))
        {
            var validTypes = GetFormLinkValidTypes(core, getterTypeToTable);
            return new("VARCHAR",
                r => (TryGet(r, prop) as IFormLinkGetter)?.FormKeyNullable?.ToString(),
                "formKey", validTypes, _empty, null, AllowsNull: IsNullableFormLink(core));
        }

        // ── IReadOnlyList<T> ──────────────────────────────────────────────────

        if (IsListType(core, out var elementType))
        {
            var elemCore = elementType;
            var isFl = IsFormLink(elemCore);
            var isLoqui = !isFl && IsLoquiInterface(elemCore);

            IReadOnlyList<SubFieldSpec>? elemSubFields = isLoqui
                ? BuildSubSchema(elemCore, getterTypeToTable, logger) : null;

            var elemMeta = BuildElementMeta(elementType, getterTypeToTable, logger);
            if (elemMeta == null) return null;

            Func<IMajorRecordGetter, object?> extractor = r =>
            {
                try // Stryker disable once Block: per-call accessor lambda stays silent per MEditService CLAUDE.md; SerializeListItems can throw on unusual record types in real game data
                {
                    return TryGet(r, prop) is IEnumerable list
                        ? SerializeListItems(list, elementType, elemSubFields)
                        : null;
                }
                catch { return null; }
            };

            Action<IMajorRecord, JsonElement>? apply = null;
            if (isFl || isLoqui)
            {
                var capturedPName = pName;
                var capturedElemCore = elemCore;
                var capturedSubFields = elemSubFields;
                var capturedIsFl = isFl;
                var capturedIsLoqui = isLoqui;

                apply = (record, json) =>
                {
                    if (json.ValueKind != JsonValueKind.Array) return;
                    var rp = record.GetType()
                        .GetProperty(capturedPName, BindingFlags.Public | BindingFlags.Instance)!;

                    var listType = rp.PropertyType;
                    var newList = Activator.CreateInstance(listType)!;
                    var addMethod = listType.GetMethod("Add")!;

                    foreach (var elem in json.EnumerateArray())
                    {
                        object? item = null;
                        if (capturedIsFl)
                        {
                            var fkStr = elem.GetString();
                            if (fkStr != null && FormKey.TryFactory(fkStr, out var fk))
                            {
                                var flType = typeof(FormLink<>).MakeGenericType(
                                    capturedElemCore.GetGenericArguments()[0]);
                                item = Activator.CreateInstance(flType, fk);
                            }
                        }
                        // Derive the concrete element type from the mutable list's generic argument,
                        // not from GetSetterType — which returns the setter *interface* (e.g.
                        // IRankPlacement), not the instantiable concrete class (RankPlacement).
                        else if (capturedIsLoqui)
                        {
                            var elemConcreteType = listType.GetGenericArguments()[0];
                            var elemObj = Activator.CreateInstance(elemConcreteType)!;
                            foreach (var sf in capturedSubFields!)
                            {
                                if (elem.TryGetProperty(sf.Name, out var sfVal))
                                    sf.Apply!(elemObj, sfVal);
                            }
                            item = elemObj;
                        }
                        if (item != null) addMethod.Invoke(newList, [item]);
                    }

                    rp.SetValue(record, newList);
                };
            }

            return new("VARCHAR", extractor, "array", _empty, _empty, apply,
                ElementMeta: elemMeta);
        }

        // ── Loqui struct (sub-record) ─────────────────────────────────────────

        if (IsLoquiInterface(core))
        {
            var subFields = BuildSubSchema(core, getterTypeToTable, logger);
            if (subFields.Count == 0) return null;

            var subFieldMetas = subFields.Select(s => s.ToFieldMetadata()).ToList();
            var capturedPName = pName;
            var capturedSF = subFields;

            Func<IMajorRecordGetter, object?> extractor = r =>
            {
                var obj = TryGet(r, prop);
                return obj == null ? null
                    : JsonSerializer.Serialize(ExtractSubObject(obj, capturedSF));
            };

            var setterType = GetSetterType(core);
            Action<IMajorRecord, JsonElement>? apply = null;
            if (setterType != null)
            {
                apply = (record, json) =>
                {
                    if (json.ValueKind != JsonValueKind.Object) return;
                    var rp = record.GetType()
                        .GetProperty(capturedPName, BindingFlags.Public | BindingFlags.Instance)!;
                    var obj = rp.GetValue(record) ?? Activator.CreateInstance(setterType)!;
                    foreach (var sf in capturedSF)
                    {
                        if (json.TryGetProperty(sf.Name, out var sfVal))
                            sf.Apply!(obj, sfVal);
                    }
                    if (rp.CanWrite) rp.SetValue(record, obj);
                };
            }

            return new("VARCHAR", extractor, "struct", _empty, _empty, apply,
                SubFieldMetas: subFieldMetas);
        }

        return null;
    }

    private static object? TryGet(IMajorRecordGetter record, PropertyInfo prop)
    {
        try { return prop.GetValue(record); }
        catch { return null; } // Stryker disable once Block: silent accessor lambda — per-call lambdas stay silent to avoid log noise (see MEditService CLAUDE.md)
    }

    internal static string ToSnakeCase(string name) =>
        Regex.Replace(name, "(?<=[a-z0-9])([A-Z])", "_$1").ToLowerInvariant();
}
