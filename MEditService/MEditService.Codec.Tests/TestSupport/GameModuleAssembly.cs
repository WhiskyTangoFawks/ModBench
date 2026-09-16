using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Tests.TestSupport;

/// <summary>The Mutagen assembly a game category's records live in, resolved the same way
/// SchemaReflector resolves it internally: "Mutagen.Bethesda.&lt;Category&gt;" is the package's own
/// naming convention, not a coupling to the reflector's internals.</summary>
internal static class GameModuleAssembly
{
    internal static Assembly? For(GameCategory category)
    {
        var assemblyName = $"Mutagen.Bethesda.{category}";
        var loaded = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == assemblyName);
        if (loaded != null) return loaded;

        try
        {
            return Assembly.Load(assemblyName);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
    }
}
