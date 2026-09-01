using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.Tests.RealData;

/// <summary>
/// The vanilla proof behind every canonical-form claim in <see cref="MalformedPluginScan"/>'s
/// tables (#569 R1's "vanilla-proof scan", extended to all five detectors): scanning the shipped
/// game's own plugins must produce <b>zero</b> diagnoses, because "malformed" is defined as
/// departing from what the Creation Kit writes (CONTEXT.md) — a vanilla hit is by definition a
/// false positive, and the fix is tightening the table, never suppressing the record.
///
/// <c>MEDIT_SMOKE=1</c>-gated like <see cref="RealInstallSmokeTests"/>: needs a locally installed
/// game, discovered via <see cref="GameLocator"/>; skipped (not passed) without one.
/// </summary>
public sealed class VanillaMalformedScanProofTests
{
    private sealed class SmokeFactAttribute : FactAttribute
    {
        public SmokeFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
                Skip = "Set MEDIT_SMOKE=1 to run the vanilla-proof scan.";
        }
    }

    [SmokeFact]
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
