using System.Reflection;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>Every Mutagen game-module assembly this build references, by the reflector's own
/// support check — a schema's <c>RecordType</c> sits in that same module.</summary>
public static class ReferencedGameModules
{
    public static IEnumerable<Assembly> Sweep() =>
        Enum.GetValues<GameRelease>()
            .Where(release => SharedSchemaReflector.Instance.IsSupported(release))
            .Select(release => SharedSchemaReflector.Instance.GetSchemas(release).Values.First().RecordType.Assembly)
            .Distinct();
}
