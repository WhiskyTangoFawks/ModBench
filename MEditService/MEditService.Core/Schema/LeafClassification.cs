using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Core.Schema;

/// <summary>What kind of leaf a reflected property is, and the neutral facts that leaf carries —
/// the one classification both a top-level column and a struct/array sub-field ask, so the two can
/// never disagree about a property's api type, its enum domain or its converter.</summary>
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
        // number the caller never typed — see LeafWriters.IsDecliningConverterException for what that becomes.
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

    // Bitmask flag values travel as decimal strings (to survive JSON above 2^53) but legacy
    // callers may still send numbers. Accept either JSON token kind.
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
            // A value-type primitive is omitted from the document exactly when it equals its
            // CLR default, so a view has to put that default back or the column reads NULL where the
            // wide table held 0/false. A string has no such default — null is the honest answer, and
            // the wide column stored NULL for it too.
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
                AllowsNull: ReflectedTypes.IsNullableFormLink(core));
        }

        return null;
    }

    // Enum leaf, shared by both projections. Bitmask ([Flags] with power-of-two members) stores as
    // BIGINT and round-trips through decimal strings; a plain enum stores its name as VARCHAR.
    internal static LeafSpec ClassifyEnumLeaf(PropertyInfo prop, Type core)
    {
        var g = ReflectedTypes.SubGetter(prop);
        var members = GetEnumMembers(core);

        // Whether the serializer writes this enum as an array of member names, which is a
        // question about the CLR type's [Flags] attribute and nothing else. Whether every member
        // carries a bit answers a different, narrower question (does it have power-of-two members)
        // and gets it wrong for this purpose — a [Flags] enum with no such members still
        // serializes as an array.
        var isFlags = core.GetCustomAttribute<FlagsAttribute>() != null;

        // The default a view falls back to when the serializer omitted the field. A flags enum's
        // rendering is a joined name list, so its default is the empty string — the same thing an
        // empty array renders as, which is what makes absent and "no flags set" indistinguishable
        // by design. A plain enum falls back to whichever member is zero, when one is defined.
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
