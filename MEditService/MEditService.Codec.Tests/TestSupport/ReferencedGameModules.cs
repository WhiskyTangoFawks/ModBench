using System.Reflection;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>Every Mutagen game-module assembly this build references — a schema's
/// <c>RecordType</c> sits in that same module.</summary>
public static class ReferencedGameModules
{
    public static IEnumerable<Assembly> Sweep() =>
        Enum.GetValues<GameRelease>()
            .Select(ModuleOf)
            .OfType<Assembly>()
            .Distinct();

    private static Assembly? ModuleOf(GameRelease release)
    {
        try
        {
            return SharedSchemaReflector.Instance.GetSchemas(release).Values.First().RecordType.Assembly;
        }
        catch (UnsupportedGameReleaseException)
        {
            return null;
        }
    }
}
