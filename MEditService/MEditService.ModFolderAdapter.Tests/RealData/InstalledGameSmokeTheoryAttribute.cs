using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;
using Xunit.Sdk;

namespace MEditService.ModFolderAdapter.Tests.RealData;

/// <summary>A smoke theory that skips, rather than finds no data, on a machine with none of the given releases installed.</summary>
[TraitDiscoverer(KindDiscoverer.TypeName, KindDiscoverer.AssemblyName)]
public sealed class InstalledGameSmokeTheoryAttribute : TheoryAttribute, ITraitAttribute
{
    public InstalledGameSmokeTheoryAttribute(params GameRelease[] anyOf)
    {
        if (!anyOf.Any(IsInstalled))
            Skip = $"None of {string.Join(", ", anyOf)} is installed.";
    }

    public string Kind { get; } = KindDiscoverer.Smoke;

    public static bool IsInstalled(GameRelease release) => new GameLocator().TryGetDataDirectory(release, out _);
}
