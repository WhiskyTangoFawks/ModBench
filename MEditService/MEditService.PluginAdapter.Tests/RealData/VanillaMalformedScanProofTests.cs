using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.PluginAdapter.Tests.RealData;

public sealed class VanillaMalformedScanProofTests
{
    [SmokeFact("run the vanilla-proof scan")]
    public void VanillaPlugins_TripNoDetector()
    {
        if (!new GameLocator().TryGetDataDirectory(GameRelease.Fallout4, out var dataDir))
            return;

        var falsePositives = new List<string>();
        foreach (var path in Directory.EnumerateFiles(dataDir.Path)
                     .Where(p => Path.GetExtension(p) is ".esm" or ".esp" or ".esl"))
        {
            foreach (var d in PluginBinaryHash.ClaimOfFile(path)?.Diagnoses ?? [])
                falsePositives.Add($"{Path.GetFileName(path)}: {d.Anchor} — {d.DefectClass}: {d.Message}");
        }

        Assert.True(falsePositives.Count == 0,
            "MalformedPluginScan flagged vanilla data — the table row is wrong, not the game:\n"
            + string.Join('\n', falsePositives));
    }
}
