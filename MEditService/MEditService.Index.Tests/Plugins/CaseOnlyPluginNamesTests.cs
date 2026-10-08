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

    private LoadOrderEntry Twin => Named("Dup.esp") with { Name = "dup.esp", Winning = false };

    private OpenedIndex Reconciled(params LoadOrderEntry[] plugins) =>
        Indexes.Reconciled(_fixture.GameDirectory, plugins, _fixture.InstanceRoot);

    private void Arrive(OpenedIndex index, params LoadOrderEntry[] plugins) =>
        index.Reconcile(index.Holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private static string[] IndexedNames(OpenedIndex index) =>
        [.. index.Records.GetPlugins().Select(row => row.Plugin.Name).Order(StringComparer.Ordinal)];

    [Fact]
    public void Reconcile_TwoNamesDifferingOnlyInCase_FailsBothNamingTheOtherAndIndexesTheRest()
    {
        using var index = Reconciled(Named("Dup.esp"), Twin, Named("Fine.esp"));

        var failures = index.Status.Failures;
        Assert.Equal(["Dup.esp", "dup.esp"], failures.Select(f => f.Name).Order(StringComparer.Ordinal));
        Assert.Contains("dup.esp", failures.Single(f => f.Name == "Dup.esp").Reason);
        Assert.Contains("Dup.esp", failures.Single(f => f.Name == "dup.esp").Reason);
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionArrivingAfterOneIndexed_UnregistersIt()
    {
        using var index = Reconciled(Named("Dup.esp"), Named("Fine.esp"));
        Assert.Empty(index.Status.Failures);

        Arrive(index, Named("Dup.esp"), Twin, Named("Fine.esp"));

        Assert.Equal(2, index.Status.Failures.Count);
        Assert.Equal(["Fine.esp"], IndexedNames(index));
    }

    [Fact]
    public void Reconcile_ACollisionAsTheOnlyChange_IsReported()
    {
        using var index = Reconciled(Named("Fine.esp"));

        Arrive(index, Named("Fine.esp"), Named("Dup.esp") with { Winning = false }, Twin);

        Assert.Equal(2, index.Status.Failures.Count);
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
}
