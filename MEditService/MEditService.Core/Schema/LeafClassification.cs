using System.Reflection;
using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

/// <summary>What kind of leaf a reflected property is — the one classification a column and a
/// sub-field both ask, so the two never disagree. Each kind names how the codec spells the value in
/// the document.</summary>
internal static class LeafClassification
{
    internal static string[] GetFormLinkValidTypes(
        Type core, GameReflection game)
    {
        var linked = core.IsGenericType ? core.GetGenericArguments()[0] : null;
        return linked != null && game.GetterTypeToTable.TryGetValue(linked, out var tn)
            ? [tn] : LeafSpec.NoFormKeyTypes;
    }

    // A 64-bit width presents as "int" like every other integer: the wire vocabulary has no wider
    // member, and a JSON number past 2^53 loses precision.
    internal static readonly Dictionary<Type, (string DuckDbType, string ApiType)> PrimitiveMap = new()
    {
        [typeof(bool)] = ("BOOLEAN", "bool"),
        [typeof(byte)] = ("INTEGER", "int"),
        [typeof(sbyte)] = ("INTEGER", "int"),
        [typeof(short)] = ("INTEGER", "int"),
        [typeof(ushort)] = ("INTEGER", "int"),
        [typeof(int)] = ("INTEGER", "int"),
        [typeof(uint)] = ("INTEGER", "int"),
        [typeof(long)] = ("BIGINT", "int"),
        [typeof(ulong)] = ("BIGINT", "int"),
        [typeof(float)] = ("FLOAT", "float"),
        [typeof(string)] = ("VARCHAR", "string"),
    };

    internal static bool TryMapPrimitive(Type core, out string duckDbType, out string apiType)
    {
        if (PrimitiveMap.TryGetValue(core, out var mapped))
        {
            (duckDbType, apiType) = mapped;
            return true;
        }
        duckDbType = ""; apiType = "";
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

    // Classifies the leaf kinds shared by both dispatch paths: primitive, translated-string,
    // byte slice, color, vector, mod key, enum, form-link. Returns null for list/loqui-struct — the
    // callers handle those.
    internal static LeafSpec? ClassifyLeaf(
        PropertyInfo prop, Type core, GameReflection game)
    {
        if (TryMapPrimitive(core, out var duckDb, out var apiType))
        {
            // A string has no default the codec omits, so null is honest; a value type's view puts
            // the declared default back.
            if (core == typeof(string))
                return new(apiType, duckDb, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
            var declared = NonZero(game.Defaults.Of(prop));
            var zero = core == typeof(bool) ? "false" : "0";
            var literal = declared == null ? zero
                : System.Convert.ToString(declared, System.Globalization.CultureInfo.InvariantCulture)!.ToLowerInvariant();
            return new(apiType, duckDb, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                ViewDefaultLiteral: literal, Default: declared);
        }

        if (ReflectedTypes.IsTranslatedString(core))
            return new("translatedString", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        if (ByteSliceHex.IsByteSlice(core))
            return new(ByteSliceHex.HexApiType, "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        if (ReflectedTypes.IsAtomicValueType(core))
            return new("color", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        if (ReflectedTypes.IsVectorStructType(core))
            return new("vector", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        if (ReflectedTypes.IsModKey(core))
            return new("string", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        if (core.IsEnum)
            return ClassifyEnumLeaf(core, game.Defaults.Of(prop));

        if (ReflectedTypes.IsFormLink(core))
        {
            return new("formKey", "VARCHAR", GetFormLinkValidTypes(core, game), LeafSpec.NoEnumMembers,
                AllowsNull: ReflectedTypes.IsNullableFormLink(core) || game.Annotations.IsPermittedNullFormLink(prop));
        }

        return null;
    }

    // Enum leaf, shared by both projections. The codec writes a [Flags] enum as an array of member
    // names ("flags"), a plain enum as its name. `declared` is null where the leaf has no owner (a
    // list element, the mod header).
    internal static LeafSpec ClassifyEnumLeaf(Type core, object? declared = null)
    {
        var members = GetEnumMembers(core);

        // Whether the serializer writes this enum as a name array is a question about the Flags
        // attribute alone, since a flags enum with no power-of-two members still serializes as an array.
        if (core.GetCustomAttribute<FlagsAttribute>() != null)
        {
            // A flags enum renders as a joined name list in a view, so its default is the empty string.
            var set = NonZero(declared) is { } bits ? bits.ToString()!.Split(", ") : null;
            return new("flags", "VARCHAR", LeafSpec.NoFormKeyTypes, members, ViewDefaultLiteral: "''", Default: set);
        }

        // An absent plain enum is its declared default, which the wire cannot derive from the
        // members alone, so the name always travels: the zero member's where nothing is declared.
        var name = Enum.GetName(core, declared ?? Enum.ToObject(core, 0));
        return new("enum", "VARCHAR", LeafSpec.NoFormKeyTypes, members,
            ViewDefaultLiteral: name == null ? null : $"'{name}'", Default: name);
    }

    // A declared default the CLR zero already stands for is not worth a wire member.
    private static object? NonZero(object? declared) =>
        declared switch
        {
            null => null,
            bool b => b ? b : null,
            Enum e => System.Convert.ToInt64(e, System.Globalization.CultureInfo.InvariantCulture) == 0 ? null : e,
            IConvertible c => System.Convert.ToDouble(c, System.Globalization.CultureInfo.InvariantCulture).CompareTo(0d) == 0 ? null : declared,
            _ => null,
        };
}
