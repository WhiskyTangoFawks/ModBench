using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.ModFolderAdapter.Tests.RealData;

/// <summary>A smoke theory that skips, rather than finds no data, on a machine with none of the given releases installed.</summary>
public sealed class InstalledGameSmokeTheoryAttribute : TheoryAttribute
{
    public InstalledGameSmokeTheoryAttribute(string reason, params GameRelease[] anyOf)
    {
        if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
            Skip = $"Set MEDIT_SMOKE=1 to {reason}.";
        else if (!anyOf.Any(IsInstalled))
            Skip = $"None of {string.Join(", ", anyOf)} is installed.";
    }

    public static bool IsInstalled(GameRelease release) => new GameLocator().TryGetDataDirectory(release, out _);
}
