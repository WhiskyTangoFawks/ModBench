using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.PluginAdapter.Tests.RealData;

[Kind(Kinds.Tool)]
public sealed class VanillaMalformedScanProofTests
{
    public static TheoryData<GameRelease, string> InstalledVanillaPlugins()
    {
        var rows = new TheoryData<GameRelease, string>();
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.SkyrimSE, GameRelease.Starfield })
        {
            if (!new GameLocator().TryGetDataDirectory(release, out var dataDir)) continue;
            foreach (var path in Directory.EnumerateFiles(dataDir.Path).Where(p => Path.GetExtension(p) is ".esm" or ".esp" or ".esl"))
                rows.Add(release, Path.GetFileName(path));
        }
        return rows;
    }

    [Theory]
    [MemberData(nameof(InstalledVanillaPlugins))]
    public void AVanillaPlugin_TripsNoDetector_ElseTheTableRowIsWrongNotTheGame(GameRelease release, string fileName)
    {
        Assert.True(new GameLocator().TryGetDataDirectory(release, out var dataDir));

        var diagnoses = TestAdapters.Mutagen().ClaimOf(Path.Combine(dataDir.Path, fileName), release).Answered().Diagnoses.Answered();

        Assert.Empty(diagnoses.Select(d => $"{d.Anchor} — {d.DefectClass}: {d.Message}"));
    }
}
