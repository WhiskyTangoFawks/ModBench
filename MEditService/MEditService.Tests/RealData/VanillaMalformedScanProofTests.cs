using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.Tests.RealData;

/// <summary>Scanning the shipped game's plugins must produce zero diagnoses: "malformed" means departing
/// from what the Creation Kit writes, so a vanilla hit is a false positive and the fix is tightening the
/// table.</summary>
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
            foreach (var d in MalformedPluginScan.Scan(File.ReadAllBytes(path)))
                falsePositives.Add($"{Path.GetFileName(path)}: {d.Anchor} — {d.DefectClass}: {d.Message}");
        }

        Assert.True(falsePositives.Count == 0,
            "MalformedPluginScan flagged vanilla data — the table row is wrong, not the game:\n"
            + string.Join('\n', falsePositives));
    }
}
