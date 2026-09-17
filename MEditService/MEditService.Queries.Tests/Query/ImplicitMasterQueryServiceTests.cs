using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

/// <summary>The implicit masters are a fact of the held snapshot: PUT /load-order prepends them as
/// forced rows, so the answer is a read of what was applied, never a second walk of the game
/// directory.</summary>
public sealed class ImplicitMasterQueryServiceTests
{
    private const string DataFolder = @"C:\Games\Fallout4\Data";

    private static RegisteredCopy Listed(string name, int slot) =>
        new(name, "SomeMod", $@"C:\mods\SomeMod\{name}", slot, Enabled: true, Winning: true);

    private static string[] ImplicitMastersOf(params RegisteredCopy[] copies) =>
        [.. new ImplicitMasterQueryService(FakeLoadOrder.Of(GameRelease.Fallout4, copies)).GetImplicitMasters()];

    [Fact]
    public void GetImplicitMasters_AreTheForcedCopies_InTheOrderTheSnapshotHoldsThem()
    {
        var names = ImplicitMastersOf(
            RegisteredCopy.Forced(DataFolder, "Fallout4.esm", 0),
            RegisteredCopy.Forced(DataFolder, "DLCRobot.esm", 1),
            RegisteredCopy.Forced(DataFolder, "ccBGSFO4001-PipBoy.esl", 2),
            Listed("UserMod.esp", 3));

        Assert.Equal(["Fallout4.esm", "DLCRobot.esm", "ccBGSFO4001-PipBoy.esl"], names);
    }

    // RegisteredCopy.IsForced is the fact, never the slot: a copy a plugins.txt line names is not a
    // forced name, wherever it sits.
    [Fact]
    public void GetImplicitMasters_ACopyAListLineNames_IsNotOne()
    {
        Assert.Equal(["Fallout4.esm"], ImplicitMastersOf(
            RegisteredCopy.Forced(DataFolder, "Fallout4.esm", 0), Listed("Fallout4.esm2", 1)));
    }

    // "No implicit masters" and "no load order" want opposite answers from the caller.
    [Fact]
    public void GetImplicitMasters_ASnapshotHoldingNoForcedCopy_IsEmpty()
    {
        Assert.Empty(ImplicitMastersOf(Listed("UserMod.esp", 0)));
    }

    [Fact]
    public void GetImplicitMasters_WithNoLoadOrderHeld_Throws()
    {
        var service = new ImplicitMasterQueryService(new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(service.GetImplicitMasters);
    }
}
