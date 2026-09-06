using System.Drawing;
using System.Globalization;
using System.Reflection;
using MEditService.Core.Queries;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>What kind of leaf a reflected property is — the one classification a column, a nested
/// member and an array element all ask, so the three never disagree.</summary>
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
            long v = Convert.ToInt64(allValues.GetValue(i), CultureInfo.InvariantCulture);
            if (v > 0 && (v & (v - 1)) == 0)   // atomic power-of-two only; excludes None=0 and composite values
                atomic.Add(new EnumMember(allNames[i], v.ToString(CultureInfo.InvariantCulture)));
        }
        return atomic.Count > 0 ? atomic.ToArray() : [.. allNames.Select(n => new EnumMember(n))];
    }

    // Every leaf kind, and null for list/loqui-struct, which the callers handle. A null `prop` is an
    // array element: no member to ask for a declared default or a permitted null link.
    internal static LeafSpec? ClassifyLeaf(
        PropertyInfo? prop, Type core, GameReflection game)
    {
        var declared = prop == null ? null : game.Defaults.Of(prop);

        if (TryMapPrimitive(core, out var duckDb, out var apiType))
        {
            // A string has no default the codec omits, so null is honest; a value type's view puts
            // the declared default back.
            if (core == typeof(string))
                return new(apiType, duckDb, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
            var nonZero = NonZero(declared);
            var zero = core == typeof(bool) ? "false" : "0";
            var literal = nonZero == null ? zero
                : Convert.ToString(nonZero, CultureInfo.InvariantCulture)!.ToLowerInvariant();
            return new(apiType, duckDb, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                ViewDefaultLiteral: literal, Default: nonZero);
        }

        if (ReflectedTypes.IsTranslatedString(core))
            return new("translatedString", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        // A hex blob, a colour and a vector each have a zero the wire's own 0 does not stand for and
        // the type name alone cannot say, so the leaf carries the codec's own spelling of it.
        if (ByteSliceHex.IsByteSlice(core))
            return Spelled(ByteSliceHex.HexApiType, declared is ReadOnlyMemorySlice<byte> s ? ByteSliceHex.ToHex(s.Span) : null);

        if (ReflectedTypes.IsAtomicValueType(core))
            return Spelled("color", declared is Color c ? c.ToHexString() : null);

        if (ReflectedTypes.IsVectorStructType(core))
            return Spelled("vector", declared == null ? null : Convert.ToString(declared, CultureInfo.InvariantCulture));

        if (ReflectedTypes.IsModKey(core))
            return new("string", "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);

        if (core.IsEnum)
            return ClassifyEnumLeaf(core, declared);

        if (ReflectedTypes.IsFormLink(core))
        {
            return new("formKey", "VARCHAR", GetFormLinkValidTypes(core, game), LeafSpec.NoEnumMembers,
                AllowsNull: ReflectedTypes.IsNullableFormLink(core)
                    || (prop != null && game.Annotations.IsPermittedNullFormLink(prop)));
        }

        return null;
    }

    // One text leaf whose zero, where the codec named one, the schema spells for the wire and for a
    // view alike.
    private static LeafSpec Spelled(string apiType, string? zero) =>
        new(apiType, "VARCHAR", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            ViewDefaultLiteral: zero == null ? null : $"'{zero}'", Default: zero);

    // Enum leaf, shared by every projection. The codec writes a [Flags] enum as an array of member
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
            Enum e => Convert.ToInt64(e, CultureInfo.InvariantCulture) == 0 ? null : e,
            IConvertible c => Convert.ToDouble(c, CultureInfo.InvariantCulture).CompareTo(0d) == 0 ? null : declared,
            _ => null,
        };
}
