using System.Reflection;
using Loqui;
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

    // Loqui's own registry answers for a class or a getter interface alike, an open generic
    // included, whose statics reflection cannot invoke.
    private static ILoquiRegistration? Registration(Type type) =>
        LoquiRegistration.TryGetRegister(type, out var registration) ? registration : null;

    /// <summary>The concrete mutable class behind a getter interface (RankPlacement for
    /// IRankPlacementGetter), open where the interface is generic.</summary>
    internal static Type? GetSetterType(Type getterInterface) => Registration(getterInterface)?.ClassType;

    /// <summary>A Loqui class's own getter interface, open where the class is generic.</summary>
    internal static Type? GetOwnGetterType(Type loquiClass) => Registration(loquiClass)?.GetterType;

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

    /// <summary>The name the codec writes as <c>MutagenObjectType</c> for this class (the
    /// serializer's <c>GetNameWithDeclaringType</c>); <paramref name="typeArguments"/> close an open
    /// generic by name, never by constructing the closed type.</summary>
    internal static string DocumentTypeName(Type type, Type[]? typeArguments = null)
    {
        var name = type.DeclaringType == null ? type.Name : $"{type.DeclaringType.Name}+{type.Name}";
        var arity = name.IndexOf('`', StringComparison.Ordinal);
        if (arity < 0) return name;
        var arguments = typeArguments is { Length: > 0 } ? typeArguments : type.GetGenericArguments();
        return $"{name[..arity]}<{string.Join(", ", arguments.Select(a => DocumentTypeName(a)))}>";
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
