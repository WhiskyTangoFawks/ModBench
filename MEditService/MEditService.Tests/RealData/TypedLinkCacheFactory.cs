using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

// GetOrAddAsOverride is defined only on the typed ILinkCache<TMod, TModGetter>, and the load order
// itself holds an untyped one that exposes only resolution, so the placed-record write paths need
// this.

// Reflection over the game's mod types, not a named game, so the all-games invariant holds.
internal static class TypedLinkCacheFactory
{
    public static ILinkCache Create(IReadOnlyList<IModGetter> mods, GameRelease release)
    {
        var category = release.ToCategory();
        var assemblyName = $"Mutagen.Bethesda.{category}";
        var assembly = AppDomain.CurrentDomain.GetAssemblies()
                           .FirstOrDefault(a => a.GetName().Name == assemblyName)
                       ?? Assembly.Load(assemblyName);

        var modGetterType = assembly.GetType($"Mutagen.Bethesda.{category}.I{category}ModGetter")!;
        var modType = assembly.GetType($"Mutagen.Bethesda.{category}.I{category}Mod")!;

        var method = typeof(LinkCacheConstructionMixIn).GetMethods()
            .First(IsBareEnumerableToImmutableLinkCache)
            .MakeGenericMethod(modType, modGetterType);

        // The mods are TModGetter at runtime; a typed array satisfies IEnumerable<TModGetter>.
        var typed = Array.CreateInstance(modGetterType, mods.Count);
        for (var i = 0; i < mods.Count; i++)
            typed.SetValue(mods[i], i);

        return (ILinkCache)method.Invoke(null, [typed, null])!;
    }

    // ToImmutableLinkCache<TMod, TModGetter>(this IEnumerable<TModGetter>) — the overload whose
    // first parameter element is the bare type parameter (not a wrapping IModListingGetter<>).
    private static bool IsBareEnumerableToImmutableLinkCache(MethodInfo m) =>
        m is { Name: "ToImmutableLinkCache", IsGenericMethodDefinition: true }
        && m.GetGenericArguments().Length == 2
        && HasBareEnumerableParameter(m);

    private static bool HasBareEnumerableParameter(MethodInfo m) =>
        m.GetParameters() is [{ ParameterType: { IsGenericType: true } p }, _]
        && p.GetGenericTypeDefinition() == typeof(IEnumerable<>)
        && p.GetGenericArguments()[0].IsGenericParameter;
}
