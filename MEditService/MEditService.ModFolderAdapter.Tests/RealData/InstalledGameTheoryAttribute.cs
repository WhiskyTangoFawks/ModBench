using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

/// <summary>A theory that skips, rather than finds no data, on a machine with none of the given releases installed.</summary>
public sealed class InstalledGameTheoryAttribute : TheoryAttribute
{
    public InstalledGameTheoryAttribute(params GameRelease[] anyOf)
    {
        if (!anyOf.Any(IsInstalled))
            Skip = $"None of {string.Join(", ", anyOf)} is installed.";
    }

    public static bool IsInstalled(GameRelease release) => new GameLocator().TryGetDataDirectory(release, out _);
}
