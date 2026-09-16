using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Tests.TestSupport;

/// <summary>The Mutagen assembly a game category's records live in: "Mutagen.Bethesda.&lt;Category&gt;"
/// is the package's own naming convention.</summary>
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
