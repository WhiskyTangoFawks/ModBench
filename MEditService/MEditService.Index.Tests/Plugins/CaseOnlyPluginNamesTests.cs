using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

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
        Indexes.Reconciled(_fixture.GameDirectory, plugins, _fixture.InstanceRoot);

    private void Arrive(OpenedIndex index, params LoadOrderEntry[] plugins) =>
        index.Reconcile(index.Holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private static string[] IndexedNames(OpenedIndex index) =>
        [.. index.Records.GetPlugins().Select(row => row.Plugin.Name).Order(StringComparer.Ordinal)];

    private static string[] FailedNames(OpenedIndex index) =>
        [.. index.Status.Failures.Select(f => f.Name).Order(StringComparer.Ordinal)];

    [Fact]
    public void Reconcile_TwoNamesDifferingOnlyInCase_FailsBothNamingTheOtherAndIndexesTheRest()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        var failures = index.Status.Failures;
        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(
            "Its name differs only in case from dup.esp from ModA, so no one can tell which the game loads. None is read.",
            failures.Single(f => f.Name == "Dup.esp").Reason);
        Assert.Equal(
            "Its name differs only in case from Dup.esp from ModA, so no one can tell which the game loads. None is read.",
            failures.Single(f => f.Name == "dup.esp").Reason);
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_TwoOriginsDifferingOnlyInCase_FailsBothSayingTheOriginCollides()
    {
        var upper = Named("Dup.esp");
        var lower = upper with { Origin = Origin.ToLowerInvariant(), Winning = false };

        using var index = Reconciled(upper, lower, Named("Fine.esp"));

        Assert.All(index.Status.Failures, f => Assert.StartsWith("Its origin differs only in case from ", f.Reason));
        Assert.Equal(2, index.Status.Failures.Count);
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ThreeNamesDifferingOnlyInCase_FailsEachNamingBothOthers()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Inactive("DUP.esp"), Named("Fine.esp"));

        Assert.Equal(["DUP.esp", "Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(
            "Its name differs only in case from Dup.esp from ModA, DUP.esp from ModA, so no one can tell which the game loads. None is read.",
            index.Status.Failures.Single(f => f.Name == "dup.esp").Reason);
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionArrivingAfterOneIndexed_UnregistersIt()
    {
        using var index = Reconciled(Named("Dup.esp"), Named("Fine.esp"));
        Assert.Empty(index.Status.Failures);

        Arrive(index, Named("Dup.esp"), Twin, Named("Fine.esp"));

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionAsTheOnlyChange_IsReported()
    {
        using var index = Reconciled(Named("Fine.esp"));

        Arrive(index, Named("Fine.esp"), Inactive("Dup.esp"), Twin);

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionThatEnds_ReadsTheSurvivorAndClearsTheFailures()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Arrive(index, Named("Dup.esp"), Named("Fine.esp"));

        Assert.Empty(index.Status.Failures);
        Assert.Equal(["Dup.esp", "Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionWhoseOtherNameLeaves_ReadsTheStayingOne()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Arrive(index, Twin, Named("Fine.esp"));

        Assert.Empty(index.Status.Failures);
        Assert.Equal(["Fine.esp", "dup.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionWithAnActiveTwin_ReadsNeitherAndItsActiveStatusIsNotHeld()
    {
        var active = Named("Dup.esp") with { Name = "dup.esp" };

        using var index = Reconciled(Inactive("Dup.esp"), active, Named("Fine.esp"));

        Assert.Equal(["Dup.esp", "dup.esp"], FailedNames(index));
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void GetProblems_WithACollidingPair_AnswersForTheRest()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        Assert.DoesNotContain(index.Problems.GetProblems(), p => p.Plugin.Name.Equals("Dup.esp", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Reconcile_AFailedPluginWhoseOriginChangesOnlyInCase_KeepsOneFailureRow()
    {
        var missing = Named("Fine.esp") with { Path = Path.Combine(_fixture.GameDirectory, "Missing.esp") };
        using var index = Reconciled(missing);
        Assert.Equal(["Fine.esp"], FailedNames(index));

        Arrive(index, missing with { Origin = Origin.ToLowerInvariant() });

        Assert.Equal(["Fine.esp"], FailedNames(index));
    }
}
