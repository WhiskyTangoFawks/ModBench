using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Schema;

/// <summary>What kind of leaf a reflected property is — the one classification a column and a
/// sub-field both ask, so the two never disagree about api type, enum domain or converter. Each
/// kind names how the codec spells the value in the document.</summary>
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

    // A CLR enum's members: a flags enum keeps only the atomic members, each with its bit, and any
    // other keeps every member with no bit.
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
        return atomic.Count > 0 ? atomic.ToArray() : [.. allNames.Select(n => new EnumMember(n))];
    }

    // The document spells a flags value as the array of contained member names, an undefined bit
    // as its hex; a decimal string or a bare number is accepted too.
    private static long ReadFlags(JsonElement v, Type enumType)
    {
        if (v.ValueKind == JsonValueKind.Array)
        {
            long bits = 0;
            foreach (var name in v.EnumerateArray()) bits |= FlagBit(name.GetString()!, enumType);
            return bits;
        }
        return v.ValueKind == JsonValueKind.String
            ? long.Parse(v.GetString()!, System.Globalization.CultureInfo.InvariantCulture)
            : v.GetInt64();
    }

    private static long FlagBit(string name, Type enumType) =>
        name.StartsWith("0x", StringComparison.Ordinal)
            ? Convert.ToInt64(name[2..], 16)
            : Convert.ToInt64(Enum.Parse(enumType, name, ignoreCase: true), System.Globalization.CultureInfo.InvariantCulture);

    // Classifies the leaf kinds shared by both dispatch paths: primitive, translated-string,
    // byte slice, color, vector, mod key, enum, form-link. Returns null for list/loqui-struct — the
    // callers handle those.
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
            return new(apiType, duckDb, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, conv, ViewDefaultLiteral: defaultLiteral);
        }

        if (ReflectedTypes.IsTranslatedString(core))
        {
            return new("translatedString", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                v => new TranslatedString(Language.English, v.GetString()));
        }

        if (ByteSliceHex.IsByteSlice(core))
            return new(ByteSliceHex.HexApiType, "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Convert: null);

        if (ReflectedTypes.IsAtomicValueType(core))
            return new("color", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Convert: null);

        if (ReflectedTypes.IsVectorStructType(core))
            return new("vector", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Convert: null);

        if (ReflectedTypes.IsModKey(core))
            return new("string", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, v => ModKey.FromFileName(v.GetString()!));

        if (core.IsEnum)
            return ClassifyEnumLeaf(core);

        if (ReflectedTypes.IsFormLink(core))
        {
            return new("formKey", "VARCHAR", GetFormLinkValidTypes(core, game), LeafSpec.NoEnumMembers,
                Convert: null,
                AllowsNull: ReflectedTypes.IsNullableFormLink(core) || game.Annotations.IsPermittedNullFormLink(prop));
        }

        return null;
    }

    // Enum leaf, shared by both projections. A [Flags] enum is written by the codec as an array of
    // member names ("flags"); a plain enum stores its name as VARCHAR.
    internal static LeafSpec ClassifyEnumLeaf(Type core)
    {
        var members = GetEnumMembers(core);

        // Whether the serializer writes this enum as a name array is a question about the Flags
        // attribute alone, since a flags enum with no power-of-two members still serializes as an array.
        if (core.GetCustomAttribute<FlagsAttribute>() != null)
        {
            // A flags enum renders as a joined name list in a view, so its default is the empty string.
            return new("flags", "VARCHAR", LeafSpec.NoFormKeyTypes, members,
                v => Enum.ToObject(core, ReadFlags(v, core)),
                ViewDefaultLiteral: "''");
        }

        var defaultLiteral = Enum.IsDefined(core, Enum.ToObject(core, 0))
            ? $"'{Enum.GetName(core, Enum.ToObject(core, 0))}'"
            : null;
        return new("enum", "VARCHAR", LeafSpec.NoFormKeyTypes, members,
            v => Enum.Parse(core, v.GetString()!, ignoreCase: true),
            ViewDefaultLiteral: defaultLiteral);
    }
}
