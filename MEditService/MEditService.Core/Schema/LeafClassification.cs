using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Schema;

/// <summary>What kind of leaf a reflected property is — the one classification a column and a
/// sub-field both ask, so the two never disagree about api type, enum domain or converter.</summary>
internal static class LeafClassification
{
    internal static string[] GetFormLinkValidTypes(
        Type core, GameReflection game)
    {
        var linked = core.IsGenericType ? core.GetGenericArguments()[0] : null;
        return linked != null && game.GetterTypeToTable.TryGetValue(linked, out var tn)
            ? [tn] : LeafSpec.NoFormKeyTypes;
    }

    internal static readonly Dictionary<Type, (string DuckDbType, string ApiType, Func<JsonElement, object?> Converter)> PrimitiveMap = new()
    {
        [typeof(bool)] = ("BOOLEAN", "bool", v => (object)v.GetBoolean()),
        // checked, so a value the width cannot hold throws rather than wrapping into a different
        // number the caller never typed.
        [typeof(byte)] = ("INTEGER", "int", v => (object)checked((byte)v.GetInt32())),
        [typeof(sbyte)] = ("INTEGER", "int", v => (object)checked((sbyte)v.GetInt32())),
        [typeof(short)] = ("INTEGER", "int", v => (object)checked((short)v.GetInt32())),
        [typeof(ushort)] = ("INTEGER", "int", v => (object)checked((ushort)v.GetInt32())),
        [typeof(int)] = ("INTEGER", "int", v => (object)v.GetInt32()),
        [typeof(uint)] = ("INTEGER", "int", v => (object)v.GetUInt32()),
        // A 64-bit width presents as "int" like every other integer: the wire vocabulary has no wider
        // member, and a value past 2^53 would need the decimal-string carriage a bitmask uses.
        [typeof(long)] = ("BIGINT", "int", v => (object)v.GetInt64()),
        [typeof(ulong)] = ("BIGINT", "int", v => (object)v.GetUInt64()),
        [typeof(float)] = ("FLOAT", "float", v => (object)v.GetSingle()),
        [typeof(string)] = ("VARCHAR", "string", v => v.GetString()),
    };

    internal static bool TryMapPrimitive(
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

    // A CLR enum's members. Bitmask ([Flags] with power-of-two members) keeps only the atomic
    // members and carries each one's bit; anything else keeps every member and carries no bit.
    private static EnumMember[] GetEnumMembers(Type enumType)
    {
        var allNames = Enum.GetNames(enumType);
        if (enumType.GetCustomAttribute<FlagsAttribute>() == null)
            return [.. allNames.Select(n => new EnumMember(n))];

        var allValues = Enum.GetValues(enumType);
        var atomic = new List<EnumMember>();
        for (int i = 0; i < allValues.Length; i++)
        {
            long v = Convert.ToInt64(allValues.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);
            if (v > 0 && (v & (v - 1)) == 0)   // atomic power-of-two only; excludes None=0 and composite values
                atomic.Add(new EnumMember(allNames[i], v.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }
        // Every member carrying a bit is what makes the field a bitmask (FieldMetadata.IsBitmask),
        // so an enum with no atomic member is a plain one and keeps every name it declares.
        return atomic.Count > 0 ? atomic.ToArray() : [.. allNames.Select(n => new EnumMember(n))];
    }

    // Bitmask values travel as decimal strings to survive JSON above 2^53; a bare number is accepted too.
    private static long ReadBitmaskLong(JsonElement v) =>
        v.ValueKind == JsonValueKind.String
            ? long.Parse(v.GetString()!, System.Globalization.CultureInfo.InvariantCulture)
            : v.GetInt64();

    // Classifies the leaf kinds shared by both dispatch paths: primitive, translated-string,
    // enum, form-link. Returns null for list/loqui-struct — the callers handle those.
    internal static LeafSpec? ClassifyLeaf(
        PropertyInfo prop, Type core, GameReflection game)
    {
        if (TryMapPrimitive(core, out var duckDb, out var apiType, out var conv))
        {
            // A value-type primitive is omitted from the document when it equals its CLR default, so a
            // view puts the default back; a string has no such default and null is honest.
            string? defaultLiteral;
            if (core == typeof(string)) defaultLiteral = null;
            else if (core == typeof(bool)) defaultLiteral = "false";
            else defaultLiteral = "0";
            return new(apiType, duckDb, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, ReflectedTypes.SubGetter(prop), conv, ViewDefaultLiteral: defaultLiteral);
        }

        if (ReflectedTypes.IsTranslatedString(core))
        {
            var g = ReflectedTypes.SubGetter(prop);
            return new("string", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                obj => { try { return (g(obj) as ITranslatedStringGetter)?.String; } catch { return null; } }, // Stryker disable once Block: silent accessor lambda — lookup-backed strings throw when game strings files are absent (see MEditService CLAUDE.md)
                v => new TranslatedString(Language.English, v.GetString()));
        }

        if (ByteSliceHex.IsByteSlice(core))
        {
            var g = ReflectedTypes.SubGetter(prop);
            return new(ByteSliceHex.HexApiType, "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, obj => ByteSliceHex.HexText(g(obj)), Convert: null);
        }

        if (core.IsEnum)
            return ClassifyEnumLeaf(prop, core);

        if (ReflectedTypes.IsFormLink(core))
        {
            var g = ReflectedTypes.SubGetter(prop);
            return new("formKey", "VARCHAR", GetFormLinkValidTypes(core, game), LeafSpec.NoEnumMembers,
                obj => (g(obj) as IFormLinkGetter)?.FormKeyNullable?.ToString(),
                Convert: null,
                AllowsNull: ReflectedTypes.IsNullableFormLink(core) || game.Annotations.IsPermittedNullFormLink(prop));
        }

        return null;
    }

    // Enum leaf, shared by both projections. Bitmask ([Flags] with power-of-two members) stores as
    // BIGINT and round-trips through decimal strings; a plain enum stores its name as VARCHAR.
    internal static LeafSpec ClassifyEnumLeaf(PropertyInfo prop, Type core)
    {
        var g = ReflectedTypes.SubGetter(prop);
        var members = GetEnumMembers(core);

        // Whether the serializer writes this enum as a name array is a question about the Flags
        // attribute alone, since a flags enum with no power-of-two members still serializes as an array.
        var isFlags = core.GetCustomAttribute<FlagsAttribute>() != null;

        // A flags enum renders as a joined name list, so its default is the empty string, the same as
        // an empty array; a plain enum falls back to its zero member, when defined.
        string? defaultLiteral;
        if (isFlags) defaultLiteral = "''";
        else if (Enum.IsDefined(core, Enum.ToObject(core, 0))) defaultLiteral = $"'{Enum.GetName(core, Enum.ToObject(core, 0))}'";
        else defaultLiteral = null;

        return EnumMember.IsBitmask(members)
            ? new("enum", "BIGINT", LeafSpec.NoFormKeyTypes, members,
                obj => g(obj) is { } v ? (object?)Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) : null,
                v => Enum.ToObject(core, ReadBitmaskLong(v)),
                IsFlagsEnum: isFlags, ViewDefaultLiteral: defaultLiteral)
            : new("enum", "VARCHAR", LeafSpec.NoFormKeyTypes, members,
            obj => g(obj)?.ToString(),
            v => Enum.Parse(core, v.GetString()!, ignoreCase: true),
            IsFlagsEnum: isFlags, ViewDefaultLiteral: defaultLiteral);
    }
}
