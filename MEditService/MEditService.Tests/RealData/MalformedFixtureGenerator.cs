using System.Buffers.Binary;
using System.Text;
using MEditService.Core.Source;

namespace MEditService.Tests.RealData;

/// <summary>
/// One-time tool that regenerates the committed cut-down Malformed-plugin fixtures (#569) from a
/// local LitR instance — same posture as <see cref="CutDownPluginGenerator"/>, but byte-level where
/// that one is Mutagen-level, and necessarily so: these fixtures exist <i>because</i> their records
/// are malformed, and a Mutagen DeepCopy + rewrite would normalize the very defect away. Each cut
/// keeps the source plugin's TES4 record verbatim (masters intact, so stored FormIDs keep their
/// meaning) plus one top-level GRUP per record type holding the offending records' raw bytes
/// verbatim. (A REFR outside a CELL group is not CK topology — <see cref="PluginBinaryWalk"/> and
/// the detectors read structure by adjacency and never care.)
///
/// Excluded from normal runs: acts only when <c>MEDIT_REGEN_TESTDATA=1</c> and the LitR instance
/// (<c>MEDIT_LITR_INSTANCE</c>, defaulting to <c>~/Games/FO4/LitR</c>) is present. Regenerate with:
///   MEDIT_REGEN_TESTDATA=1 dotnet test --filter FullyQualifiedName~MalformedFixtureGenerator
/// then review and commit the updated TestData files.
/// </summary>
public sealed class MalformedFixtureGenerator
{
    private static readonly (string SourceMod, string SourcePlugin, string FixtureName, (string Type, uint FormId)[] Records)[] Cuts =
    [
        ("The Charger Pistol - a Gauss based weapon platform", "GaussRevolver.esp",
            "GaussRevolver - CutDown.esp", [("WEAP", 0x01000860u)]),
        ("Lunar - UNPCs", "Lunar-UniqueCreatures.esp",
            "Lunar-UniqueCreatures - CutDown.esp", [("RACE", 0x03014174u), ("RACE", 0x0603637Au)]),
        ("South of the Sea - Atom's Storm", "SouthOfTheSea.esm",
            "SouthOfTheSea - CutDown.esm", [("REFR", 0x07431EDCu)]),
    ];

    [Fact]
    public void RegenerateMalformedFixtures()
    {
        if (Environment.GetEnvironmentVariable("MEDIT_REGEN_TESTDATA") != "1")
            return;
        var instance = Environment.GetEnvironmentVariable("MEDIT_LITR_INSTANCE")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Games", "FO4", "LitR");
        if (!Directory.Exists(instance))
            return;

        // Written to the source tree, not the test bin dir — these are committed fixtures.
        var testDataDir = Path.Combine(FindRepoRoot(), "MEditService", "MEditService.Tests", "TestData");

        foreach (var (sourceMod, sourcePlugin, fixtureName, records) in Cuts)
        {
            var bytes = File.ReadAllBytes(Path.Combine(instance, "mods", sourceMod, sourcePlugin));
            var spans = PluginBinaryWalk.WalkRecords(bytes);

            var tes4 = spans.First(r => r.Type == "TES4");
            using var output = new MemoryStream();
            output.Write(bytes, tes4.Start, 24 + tes4.DataLen);

            foreach (var group in records.GroupBy(r => r.Type))
            {
                var cut = group
                    .Select(want => spans.First(r => r.Type == want.Type && r.FormId == want.FormId))
                    .ToList();
                var payloadLen = cut.Sum(r => 24 + r.DataLen);
                output.Write(GrupHeader(group.Key, payloadLen));
                foreach (var r in cut) output.Write(bytes, r.Start, 24 + r.DataLen);
            }

            File.WriteAllBytes(Path.Combine(testDataDir, fixtureName), output.ToArray());
        }
    }

    private static byte[] GrupHeader(string label, int childBytes)
    {
        var b = new byte[24];
        Encoding.ASCII.GetBytes("GRUP").CopyTo(b, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), (uint)(24 + childBytes)); // size includes this header
        Encoding.ASCII.GetBytes(label).CopyTo(b, 8);
        // group type 0 (top-level by signature); stamp/version fields left zero
        return b;
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !Directory.Exists(Path.Combine(dir, ".git")))
            dir = Path.GetDirectoryName(dir);
        return dir ?? throw new InvalidOperationException("repo root not found above " + AppContext.BaseDirectory);
    }
}
