using System.Globalization;
using System.Reflection;
using Loqui;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Schema;

/// <summary>What a CLR type reflected off a Mutagen getter interface <i>is</i>: the structural
/// questions every leaf-kind dispatch asks. Answers only; nothing here builds a column or an applier.</summary>
internal static class ReflectedTypes
{
    internal static IEnumerable<PropertyInfo> GetAllInterfaceProperties(Type type) =>
        type.GetInterfaces()
            .Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance));

    /// <summary>Of one member declared along an interface chain, the declaration nearest the leaf.</summary>
    internal static PropertyInfo MostDerived(IEnumerable<PropertyInfo> declarations) =>
        declarations.Aggregate((best, candidate) =>
            DeclaringTypeOf(best).IsAssignableFrom(DeclaringTypeOf(candidate)) ? candidate : best);

    /// <summary>A property's declaring type. Reflection types it nullable only for a global module
    /// member, which no getter interface or Loqui class member is.</summary>
    internal static Type DeclaringTypeOf(PropertyInfo prop) =>
        prop.DeclaringType ?? throw new InvalidOperationException($"Expected '{prop.Name}' to have a declaring type.");

    /// <summary>A member's type with its <c>Nullable&lt;T&gt;</c> wrapper off, and whether that
    /// wrapper was there — the two questions every leaf dispatch opens with.</summary>
    internal static (Type Core, bool Nullable) CoreOf(PropertyInfo prop)
    {
        var underlying = Nullable.GetUnderlyingType(prop.PropertyType);
        return (underlying ?? prop.PropertyType, underlying != null || !prop.PropertyType.IsValueType);
    }

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

    // The codec writes a vector as its components in English, comma-separated
    // (NewtonsoftJsonSerializationWriterKernel.WriteP3Float). None of these types is IFormattable,
    // so formatting the whole would silently fall back to the current culture; the components are.
    private static readonly string[] VectorComponents = ["X", "Y", "Z"];

    /// <summary>One vector value spelled as the codec spells it, at either arity.</summary>
    internal static string VectorText(object value) =>
        string.Join(", ", VectorComponents
            .Select(value.GetType().GetProperty)
            .OfType<PropertyInfo>()
            .Select(p => Convert.ToString(p.GetValue(value), CultureInfo.InvariantCulture)));

    internal static bool IsAtomicValueType(Type core) => core == typeof(System.Drawing.Color);

    /// <summary>Whether the getter declares this member as possibly absent. A Loqui sub-record is a
    /// reference type, so the CLR type says nothing and only the interface's own nullable annotation
    /// answers.</summary>
    internal static bool IsNullableMember(PropertyInfo prop) =>
        new NullabilityInfoContext().Create(prop).ReadState == NullabilityState.Nullable;

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
