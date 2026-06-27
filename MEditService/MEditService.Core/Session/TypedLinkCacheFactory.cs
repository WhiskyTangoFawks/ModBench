using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

// Builds a game-typed ILinkCache<TMod, TModGetter> from the session's load-order getters.
//
// The session itself uses an untyped ImmutableLoadOrderLinkCache (ToUntypedImmutableLinkCache), which
// exposes only resolution. Pulling a record into a plugin as an override (GetOrAddAsOverride) is
// defined only on the *typed* cache, so the placed-record write paths (create/copy/delete) need this.
//
// Game-agnostic via reflection over the game's mod types (mirrors SchemaReflector) so the all-games
// invariant holds: the caller stores the result as the non-generic ILinkCache and PluginWriter reaches
// the typed methods reflectively.
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

        // ToImmutableLinkCache<TMod, TModGetter>(this IEnumerable<TModGetter>) — the overload whose
        // first parameter element is the bare type parameter (not a wrapping IModListingGetter<>).
        var method = typeof(LinkCacheConstructionMixIn).GetMethods()
            .First(m => m is { Name: "ToImmutableLinkCache", IsGenericMethodDefinition: true }
                && m.GetGenericArguments().Length == 2
                && m.GetParameters() is [{ ParameterType: { IsGenericType: true } p }, _]
                && p.GetGenericTypeDefinition() == typeof(IEnumerable<>)
                && p.GetGenericArguments()[0].IsGenericParameter)
            .MakeGenericMethod(modType, modGetterType);

        // The mods are TModGetter at runtime; a typed array satisfies IEnumerable<TModGetter>.
        var typed = Array.CreateInstance(modGetterType, mods.Count);
        for (var i = 0; i < mods.Count; i++)
            typed.SetValue(mods[i], i);

        return (ILinkCache)method.Invoke(null, [typed, null])!;
    }
}
