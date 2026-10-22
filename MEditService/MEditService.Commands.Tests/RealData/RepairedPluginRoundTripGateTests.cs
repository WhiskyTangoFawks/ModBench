using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.RealData;

public sealed class RepairedPluginRoundTripGateTests
{
    public static TheoryData<MalformationFixture> RepairedFixtures() => [.. MalformationFixtures.All.Where(f => f.Repaired != null)];

    [Theory]
    [MemberData(nameof(RepairedFixtures))]
    public async Task DecompileAndCommit_OfAMalformedPluginEveryRepairOfWhichIsMade_PassesTheRoundTripGate(MalformationFixture fixture)
    {
        const string Origin = "RepairedFixtureMod";
        using var modFolder = new ScratchDirectory("medit-repaired-mod-");
        using var dataFolder = new ScratchDirectory("medit-repaired-data-");
        using var scratch = new ScratchDirectory("medit-repaired-scratch-");
        fixture.Malformed.WriteInto(scratch);
        var malformed = Path.Combine(scratch, fixture.Malformed.FileName);
        var adapter = TestAdapters.Mutagen();
        var previews = adapter.RepairsOf(malformed, GameRelease.Fallout4).Answered();
        var repaired = adapter.WriteRepaired(malformed, previews.Hash, [.. previews.Diagnoses.Select(p => p.Diagnosis)],
            Path.Combine(modFolder, fixture.Malformed.FileName), GameRelease.Fallout4).Answered();

        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(EmptyMasterStubs.LoadOrderOver(repaired, Origin, dataFolder), Origin)).Only();

        Assert.True(result.Applied, result.Message);
    }
}
