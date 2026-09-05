using System.Reflection;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>What a CLR type reflected off a Mutagen getter interface <i>is</i>: the structural
/// questions every leaf-kind dispatch asks. Answers only; nothing here builds a column or an applier.</summary>
internal static class ReflectedTypes
{
    internal static IEnumerable<PropertyInfo> GetAllInterfaceProperties(Type type) =>
        type.GetInterfaces()
            .Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance));

    internal static bool IsTranslatedString(Type type) =>
        typeof(ITranslatedStringGetter).IsAssignableFrom(type);

    internal static bool IsFormLink(Type type) =>
        typeof(IFormLinkGetter).IsAssignableFrom(type);

    // A getter interface exposes a non-nullable FormLink as the base IFormLinkGetter<T>; only an
    // explicitly nullable one gets IFormLinkNullableGetter<T>, the one type-level signal to trust.
    internal static bool IsNullableFormLink(Type type) =>
        type.GetInterfaces().Prepend(type).Any(i =>
            i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IFormLinkNullableGetter<>));

    // IReadOnlyList<T> only — that's what Mutagen getter interfaces expose for collections.
    internal static bool IsListType(Type type, out Type elementType)
    {
        elementType = typeof(object);
        if (!type.IsGenericType) return false;
        if (type.GetGenericTypeDefinition() != typeof(IReadOnlyList<>)) return false;
        elementType = type.GetGenericArguments()[0];
        return true;
    }

    // Mutagen Loqui-generated sub-record interfaces always declare a static StaticRegistration.
    internal static bool IsLoquiInterface(Type type) =>
        type.IsInterface &&
        !IsFormLink(type) &&
        type.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;

    // A closed, verified set rather than an "any small struct with X/Y/Z" rule, which would also match
    // these types' self-referencing Point property and recurse forever. Noggog's other siblings have
    // no FO4 usages.
    private static readonly HashSet<Type> VectorStructTypes =
    [
        typeof(P3Int16), typeof(P3Float),
        typeof(P2Int), typeof(P2UInt8), typeof(P2Int16),
        typeof(P3UInt8), typeof(P3UInt16), typeof(P2Float),
    ];

    internal static bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type);

    internal static bool IsAtomicValueType(Type core) => core == typeof(System.Drawing.Color);

    // Retrieve the concrete mutable class (e.g. RankPlacement) via ILoquiRegistration.SetterType.
    internal static Type? GetSetterType(Type getterInterface)
    {
        var regProp = getterInterface.GetProperty(
            "StaticRegistration", BindingFlags.Public | BindingFlags.Static);
        var reg = regProp?.GetValue(null);
        return reg?.GetType().GetField("ClassType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) as Type;
    }

    // Mirrors GetSetterType: reads GetterType off a *concrete* Loqui class's own StaticRegistration,
    // rather than SetterType off a getter interface's.
    internal static Type? GetOwnGetterType(Type concreteClass)
    {
        var regProp = concreteClass.GetProperty(
            "StaticRegistration", BindingFlags.Public | BindingFlags.Static);
        var reg = regProp?.GetValue(null);
        return reg?.GetType().GetField("GetterType", BindingFlags.Public | BindingFlags.Static)
            ?.GetValue(null) as Type;
    }

    /// <summary>The Loqui setter class behind a getter interface, or the type itself where Loqui has
    /// none — the vocabulary a union's discriminator values are drawn from, so a union leaf and a
    /// plain struct name themselves alike.</summary>
    internal static string LeafTypeName(Type type)
    {
        var name = (GetSetterType(type) ?? type).Name;
        // A closed generic's CLR name carries its arity (OMOD's own `AObjectModProperty`1`), which
        // is spelling, not identity.
        var arity = name.IndexOf('`', StringComparison.Ordinal);
        return arity < 0 ? name : name[..arity];
    }

    // The type and its bases within its own assembly — a Loqui base is never outside it.
    internal static IEnumerable<Type> BaseChain(Type type)
    {
        for (var t = type; t != null && t.Assembly == type.Assembly; t = t.BaseType) yield return t;
    }

    internal static readonly HashSet<Type> IntegerTypes =
    [
        typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(long), typeof(ulong),
    ];

    /// <summary>The name the codec writes as <c>MutagenObjectType</c> for a value of this class
    /// (Mutagen.Bethesda.Serialization's <c>GetNameWithDeclaringType</c>), so a discriminator domain
    /// and the document agree; <paramref name="typeArguments"/> closes an open generic.</summary>
    internal static string DocumentTypeName(Type type, Type[]? typeArguments = null) =>
        DocumentTypeName(type.DeclaringType == null ? type.Name : $"{type.DeclaringType.Name}+{type.Name}", typeArguments ?? type.GetGenericArguments());

    /// <summary>The same spelling from a CLR name (<c>Outer+Inner</c>, <c>Open`1</c>) and the
    /// arguments closing it, for a generic the caller need not construct.</summary>
    internal static string DocumentTypeName(string clrName, Type[] typeArguments)
    {
        var arity = clrName.IndexOf('`', StringComparison.Ordinal);
        if (arity < 0) return clrName;
        return $"{clrName[..arity]}<{string.Join(", ", typeArguments.Select(a => DocumentTypeName(a)))}>";
    }

    internal static bool IsModKey(Type type) => type == typeof(ModKey);

    /// <summary>One property's value off any instance, or null when the accessor throws. Mutagen's
    /// getters throw for a subrecord that is genuinely absent, which is a value, not a defect.</summary>
    internal static object? ReadOrNull(object obj, PropertyInfo prop)
    {
        try { return prop.GetValue(obj); }
        catch { return null; } // Stryker disable once Block: silent accessor — per-call lambdas stay silent to avoid log noise (see MEditService CLAUDE.md)
    }
}
