using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Schema;

public sealed class SchemaReflector : ISchemaReflector
{
    // Placed/spatial records excluded from the index: too large or not meaningful to browse.
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
        _cache.GetOrAdd(category, BuildForCategory);

    private static GameSchemaCache BuildForCategory(GameCategory category)
    {
        var assemblyName = $"Mutagen.Bethesda.{category}";
        var assembly = AppDomain.CurrentDomain.GetAssemblies()
                           .FirstOrDefault(a => a.GetName().Name == assemblyName)
                       ?? Assembly.Load(assemblyName);

        var majorRecordGetterType =
            assembly.GetType($"Mutagen.Bethesda.{category}.I{category}MajorRecordGetter")
            ?? throw new NotSupportedException($"I{category}MajorRecordGetter not found in {assemblyName}");

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

            var getterInterface = assembly.GetType($"Mutagen.Bethesda.{category}.I{type.Name}Getter");
            if (getterInterface == null) continue;

            discovered.Add((tableName, getterInterface));
        }

        var getterTypeToTable = discovered.ToDictionary(d => d.getterType, d => d.tableName);

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
            schemas[tableName] = BuildSchema(tableName, getterType, getterTypeToTable);

        return new GameSchemaCache(schemas, getterTypeToTable);
    }

    private static RecordTableSchema BuildSchema(
        string tableName, Type getterType, IReadOnlyDictionary<Type, string> getterTypeToTable)
    {
        var baseSkip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "FormKey", "EditorID", "IsCompressed", "FormVersion", "VersionControl",
            "MajorRecordFlagsRaw", "SubgraphRevision"
        };

        // Group by snake_case name and pick the most-derived interface's property.
        // Interfaces like INamedGetter (string? Name) and ITranslatedNamedGetter
        // (ITranslatedStringGetter? Name) both expose "name", but only the leaf interface
        // reflects the real on-disk type. We prefer whichever declaring type is NOT a
        // base of any other declaring type in the same group (i.e. the most-specific one).
        var grouped = GetAllInterfaceProperties(getterType)
            .Where(p => !baseSkip.Contains(p.Name))
            .GroupBy(p => ToSnakeCase(p.Name), StringComparer.OrdinalIgnoreCase);

        var columns = new List<ColumnSpec>();

        foreach (var group in grouped)
        {
            var colName = group.Key;

            // Pick the property from the most-derived interface in the group.
            var prop = group.Aggregate((best, candidate) =>
                best.DeclaringType!.IsAssignableFrom(candidate.DeclaringType!) ? candidate : best);

            var info = GetColumnInfo(prop, getterTypeToTable);
            if (info == null) continue;

            columns.Add(new ColumnSpec(colName, prop.Name, info.DuckDbType, info.Extractor, info.ApiType, info.ValidFormKeyTypes, info.EnumValues, info.Apply));
        }

        return new RecordTableSchema
        {
            TableName = tableName,
            RecordType = getterType,
            RecordColumns = columns
        };
    }

    private sealed record ColumnInfoResult(
        string DuckDbType,
        Func<IMajorRecordGetter, object?> Extractor,
        string ApiType,
        string[] ValidFormKeyTypes,
        string[] EnumValues,
        Action<IMajorRecord, JsonElement>? Apply);

    private static IEnumerable<PropertyInfo> GetAllInterfaceProperties(Type type)
    {
        if (!type.IsInterface)
            return type.GetProperties(BindingFlags.Public | BindingFlags.Instance);

        return type.GetInterfaces()
            .Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance));
    }

    private static readonly string[] _empty = [];

    private static ColumnInfoResult? GetColumnInfo(
        PropertyInfo prop, IReadOnlyDictionary<Type, string> getterTypeToTable)
    {
        var type       = prop.PropertyType;
        var core       = Nullable.GetUnderlyingType(type) ?? type;
        var isNullable = Nullable.GetUnderlyingType(type) != null || !type.IsValueType;
        var propName   = prop.Name;

        Action<IMajorRecord, JsonElement> MakeApply(Func<JsonElement, object?> converter)
        {
            var cache = new ConcurrentDictionary<Type, PropertyInfo?>();
            return (record, value) =>
            {
                var rp = cache.GetOrAdd(record.GetType(), t =>
                {
                    var p = t.GetProperty(propName, BindingFlags.Public | BindingFlags.Instance);
                    return p is { CanWrite: true } ? p : null;
                });
                if (rp == null) return;

                if (value.ValueKind == JsonValueKind.Null)
                {
                    if (isNullable) rp.SetValue(record, null);
                    return;
                }

                var converted = converter(value);
                if (converted != null) rp.SetValue(record, converted);
            };
        }

        if (core == typeof(bool))
            return new("BOOLEAN", r => TryGet(r, prop), "bool", _empty, _empty,
                MakeApply(v => (object)v.GetBoolean()));

        if (core == typeof(byte))
            return new("INTEGER", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)(byte)v.GetInt32()));

        if (core == typeof(sbyte))
            return new("INTEGER", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)(sbyte)v.GetInt32()));

        if (core == typeof(short))
            return new("INTEGER", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)(short)v.GetInt32()));

        if (core == typeof(ushort))
            return new("INTEGER", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)(ushort)v.GetInt32()));

        if (core == typeof(int))
            return new("INTEGER", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)v.GetInt32()));

        if (core == typeof(uint))
            return new("INTEGER", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)v.GetUInt32()));

        if (core == typeof(long))
            return new("BIGINT", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)v.GetInt64()));

        if (core == typeof(ulong))
            return new("BIGINT", r => TryGet(r, prop), "int", _empty, _empty,
                MakeApply(v => (object)v.GetUInt64()));

        if (core == typeof(float))
            return new("FLOAT", r => TryGet(r, prop), "float", _empty, _empty,
                MakeApply(v => (object)v.GetSingle()));

        if (core == typeof(double))
            return new("DOUBLE", r => TryGet(r, prop), "float", _empty, _empty,
                MakeApply(v => (object)v.GetDouble()));

        if (core == typeof(string))
            return new("VARCHAR", r => TryGet(r, prop), "string", _empty, _empty,
                MakeApply(v => v.GetString()));

        if (IsTranslatedString(core))
            return new("VARCHAR", r =>
            {
                try { return (TryGet(r, prop) as ITranslatedStringGetter)?.String; }
                catch { return null; }
            }, "string", _empty, _empty,
                MakeApply(v => new TranslatedString(Language.English, v.GetString())));

        if (core.IsEnum)
        {
            var enumValues = Enum.GetNames(core);
            return new("VARCHAR", r => TryGet(r, prop)?.ToString(), "enum", _empty, enumValues,
                MakeApply(v => Enum.Parse(core, v.GetString() ?? "", ignoreCase: true)));
        }

        if (IsFormLink(core))
        {
            var linkedType = core.GetGenericArguments().Length > 0 ? core.GetGenericArguments()[0] : null;
            var validTypes = linkedType != null && getterTypeToTable.TryGetValue(linkedType, out var tn)
                ? new[] { tn }
                : _empty;
            return new("VARCHAR", r => (TryGet(r, prop) as IFormLinkGetter)?.FormKeyNullable?.ToString(), "formKey", validTypes, _empty, null);
        }

        return null;
    }

    private static object? TryGet(IMajorRecordGetter record, PropertyInfo prop)
    {
        try { return prop.GetValue(record); }
        catch { return null; }
    }

    private static bool IsTranslatedString(Type type) =>
        typeof(ITranslatedStringGetter).IsAssignableFrom(type);

    private static bool IsFormLink(Type type) =>
        type.IsInterface && type.IsGenericType &&
        typeof(IFormLinkGetter).IsAssignableFrom(type);

    internal static string ToSnakeCase(string name) =>
        Regex.Replace(name, "(?<=[a-z0-9])([A-Z])", "_$1").ToLowerInvariant();
}
