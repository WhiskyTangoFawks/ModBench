using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class CaseOnlyPluginNamesTests : IDisposable
{
    private const string Origin = "ModA";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("case-only-names")
        .WithPlugin("Dup.esp", mod => mod.Npcs.AddNew("FromDup"), origin: Origin)
        .WithPlugin("Fine.esp", mod => mod.Npcs.AddNew("FromFine"), origin: Origin)
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Named(string name) => _fixture.Plugins.Single(p => p.Name == name);

    private LoadOrderEntry Inactive(string name) => Named("Dup.esp") with { Name = name, Winning = false };

    private LoadOrderEntry Twin => Inactive("dup.esp");

    private OpenedIndex Reconciled(params LoadOrderEntry[] plugins) =>
        Indexes.Reconciled(_fixture.DataFolder, plugins, _fixture.InstanceRoot);

    private void Arrive(OpenedIndex index, params LoadOrderEntry[] plugins) =>
        index.Reconcile(index.Holder, _fixture.DataFolder, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private static string[] IndexedNames(OpenedIndex index) =>
        [.. index.Queries.GetPlugins().Value().Select(row => row.Name).Order(StringComparer.Ordinal)];

    private static string[] FailedNames(OpenedIndex index) =>
        [.. index.Status.Failures.Select(f => f.Name).Order(StringComparer.Ordinal)];

    [Fact]
    public void TwoNamesDifferingOnlyInCase_FailBoth_AndTheRestIndex()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void ACollisionArrivingAfterOneIndexed_UnregistersIt()
    {
        using var index = Reconciled(Named("Dup.esp"), Named("Fine.esp"));
        Assert.Empty(index.Status.Failures);

        Arrive(index, Named("Dup.esp"), Twin, Named("Fine.esp"));

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void ACollisionAsTheOnlyChange_IsReported()
    {
        using var index = Reconciled(Named("Fine.esp"));

        Arrive(index, Named("Fine.esp"), Inactive("Dup.esp"), Twin);

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
    }

    [Fact]
    public void ACollisionThatEnds_ReadsTheSurvivorAndClearsTheFailures()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Arrive(index, Named("Dup.esp"), Named("Fine.esp"));

        Assert.Empty(index.Status.Failures);
        Assert.Equal(["Dup.esp", "Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void ACollisionWhoseOtherNameLeaves_ReadsTheStayingOne()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Arrive(index, Twin, Named("Fine.esp"));

        Assert.Empty(index.Status.Failures);
        Assert.Equal(["Fine.esp", "dup.esp"], IndexedNames(index));
    }

    [Fact]
    public void ACollisionWithAnActiveTwin_ReadsNeitherAndItsActiveStatusIsNotHeld()
    {
        var active = Named("Dup.esp") with { Name = "dup.esp" };

        using var index = Reconciled(Inactive("Dup.esp"), active, Named("Fine.esp"));

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void ACollidingPair_LeavesTheProblemsAnsweredForTheRest()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Assert.DoesNotContain(index.Queries.GetProblems().Value(), p => p.Plugin.Name.Equals("Dup.esp", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AFailedPluginWhoseOriginChangesOnlyInCase_KeepsOneFailureRow()
    {
        var missing = Named("Fine.esp") with { Path = Path.Combine(_fixture.DataFolder, "Missing.esp") };
        using var index = Reconciled(missing);
        Assert.Equal(["Fine.esp"], FailedNames(index));

        Arrive(index, missing with { Origin = Origin.ToLowerInvariant() });

        Assert.Equal(["Fine.esp"], FailedNames(index));
    }

    [Fact]
    public void APluginRespelledOnlyInCase_IsNamedAsSpelledNowEverywhere()
    {
        var fine = Named("Fine.esp");
        using var index = Reconciled(fine);

        Arrive(index, fine with { Name = "fine.esp", Origin = Origin.ToLowerInvariant() });

        var now = new PluginAddress("fine.esp", Origin.ToLowerInvariant());
        Assert.Equal([now], index.Status.IndexedPlugins);
        Assert.Equal([now], index.Queries.GetPlugins().Value().Select(row => row.KeyOf()));
        var record = index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Items.Single();
        Assert.Equal(("fine.esp", "moda"), (record.Plugin, record.Origin));
    }

    [Fact]
    public void AFailedPluginRespelledOnlyInCase_IsNamedAsSpelledNow()
    {
        var missing = Named("Fine.esp") with { Path = Path.Combine(_fixture.DataFolder, "Missing.esp") };
        using var index = Reconciled(missing);

        Arrive(index, missing with { Name = "fine.esp" });

        Assert.Equal(["fine.esp"], FailedNames(index));
    }

    [PosixFact]
    public void AFileRenamedOnDiskOnlyInCase_KeepsItsRowsUnderTheNewSpelling()
    {
        var fine = Named("Fine.esp");
        using var index = Reconciled(fine);
        var renamed = Path.Combine(Path.GetDirectoryName(fine.Path).Require(), "fine.esp");
        File.Move(fine.Path, renamed);

        Arrive(index, fine with { Name = "fine.esp", Path = renamed });

        Assert.Empty(index.Status.Failures);
        var record = index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Items.Single();
        Assert.Equal(("fine.esp", "FromFine"), (record.Plugin, record.EditorId));
    }
}
