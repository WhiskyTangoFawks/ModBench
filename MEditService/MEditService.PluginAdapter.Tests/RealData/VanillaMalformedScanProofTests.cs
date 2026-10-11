using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.PluginAdapter.Tests.RealData;

public sealed class VanillaMalformedScanProofTests
{
    public static TheoryData<GameRelease, string> InstalledVanillaPlugins()
    {
        var rows = new TheoryData<GameRelease, string>();
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.SkyrimSE, GameRelease.Starfield })
        {
            if (!new GameLocator().TryGetDataDirectory(release, out var dataDir)) continue;
            foreach (var path in Directory.EnumerateFiles(dataDir.Path).Where(p => Path.GetExtension(p) is ".esm" or ".esp" or ".esl"))
                rows.Add(release, path);
        }
        return rows;
    }

    [SmokeTheory("run the vanilla-proof scan")]
    [MemberData(nameof(InstalledVanillaPlugins))]
    public void AVanillaPlugin_TripsNoDetector_ElseTheTableRowIsWrongNotTheGame(GameRelease release, string path)
    {
        var diagnoses = TestAdapters.Mutagen().ClaimOf(path, release).Answered().Diagnoses.Answered();

        Assert.Empty(diagnoses.Select(d => $"{d.Anchor} — {d.DefectClass}: {d.Message}"));
    }
}
