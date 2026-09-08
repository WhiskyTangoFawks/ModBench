using MEditService.Core.Records;
using MEditService.Tests.Edits;

namespace MEditService.Tests.Records;

/// <summary>ADR-0046 invariant 4, end to end: the cascade writes three source trees and returns, and
/// the Source watcher lands every rewritten reference. A failed renumber's restore reaches the Index
/// the same way.</summary>
public sealed class RenumberCascadeWatchTests
{
    private const string NewRaceFormKey = "000F00:Target.esp";

    [Fact]
    public async Task ARenumberAcrossThreeTrackedMods_LandsEveryRewrittenReferenceThroughTheWatcher()
    {
        using var fixture = CascadeRollbackFixture.Watched();

        var result = fixture.RenumberHandler.RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString(), NewRaceFormKey);
        Assert.True(result.Applied, result.Message);

        // Nothing was pushed: what the Index knows, it learns from the trees the command wrote.
        Assert.True(
            await fixture.ProjectionReaches(reads =>
                reads.GetDocument(NewRaceFormKey, fixture.TargetPlugin) != null
                && reads.GetReferencedBy(NewRaceFormKey).Select(r => r.FormKey).Distinct().Count() == 3),
            "the renumbered race and its three rewritten referencers never reached the index");

        var landed = fixture.Index!.Store!.At(RecordRef.Effective);
        Assert.Null(landed.GetDocument(fixture.Race.ToString(), fixture.TargetPlugin));
        Assert.Empty(landed.GetReferencedBy(fixture.Race.ToString()));

        // Each referencing plugin's own row, so a cascade that landed one mod's rewrite and not the
        // others cannot pass.
        var referencers = landed.GetReferencedBy(NewRaceFormKey)
            .Select(r => (r.Plugin, r.Origin)).Distinct().Order().ToList();
        Assert.Equal(
            [(fixture.FirstPlugin.Name, fixture.FirstPlugin.Origin!),
             (fixture.SecondPlugin.Name, fixture.SecondPlugin.Origin!),
             (fixture.TargetPlugin.Name, fixture.TargetPlugin.Origin!)],
            referencers.Order().ToList());
    }

    [Fact]
    public async Task AFailedRenumbersRestore_LeavesTheWatcherProjectingTheOldIdentity()
    {
        using var fixture = CascadeRollbackFixture.Watched();

        // The race's own destination, reached after every referencing document has been rewritten:
        // the restore below is three real file writes, and the watcher sees them like any other.
        var blocked = fixture.RenumberedRacePath(NewRaceFormKey);
        Directory.CreateDirectory(blocked);

        Assert.Throws<IOException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString(), NewRaceFormKey));

        Assert.True(
            await fixture.ProjectionReaches(reads =>
                reads.GetReferencedBy(fixture.Race.ToString()).Select(r => r.FormKey).Distinct().Count() == 3
                && reads.GetDocument(NewRaceFormKey, fixture.TargetPlugin) == null),
            "the restored trees never brought the index back to the old identity");

        Assert.NotNull(fixture.Index!.Store!.At(RecordRef.Effective)
            .GetDocument(fixture.Race.ToString(), fixture.TargetPlugin));
    }
}
