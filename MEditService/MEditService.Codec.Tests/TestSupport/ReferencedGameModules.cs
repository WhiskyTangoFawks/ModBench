using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>Every Mutagen game-module assembly this build references.</summary>
public static class ReferencedGameModules
{
    public static IEnumerable<Assembly> Sweep() =>
        Enum.GetValues<GameCategory>()
            .Select(ModuleOf)
            .OfType<Assembly>();

    private static Assembly? ModuleOf(GameCategory category)
    {
        try
        {
            return Assembly.Load($"Mutagen.Bethesda.{category}");
        }
        catch (FileNotFoundException)
        {
            return null;
        }
    }
}
