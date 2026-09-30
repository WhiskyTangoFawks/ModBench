using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0015 invariant 4 over the other system of record: an untracked plugin's rows came from
/// its binary, which carries no unit smaller than itself, so validate reports and the Indexer
/// re-derives.</summary>
public sealed class ValidateUntrackedTests : IDisposable
{
    private const string PluginName = "Fixture.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly Indexer _index;

    public ValidateUntrackedTests()
    {
        _fixture = new PluginFixtureBuilder("validate-untracked")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered();
        _mod = _fixture.Plugins.Single();
        var holder = new LoadOrderHolder();
        var clockPastEveryWrite = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        _index = new Indexer(
            holder, TestAdapters.Mutagen(), SharedSchemaReflector.Instance, timeProvider: clockPastEveryWrite);
        _index.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private ValidationReport Validate() => Assert.Single(_index.ValidateIndex(_mod.KeyOf()));

    [Fact]
    public void AnUnchangedBinary_ValidatesClean()
    {
        var before = _index.Sequence;

        var report = Validate();

        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.ChangedKeys);
        Assert.Equal(before, _index.Sequence);
    }

    // A handle that denies sharing makes a read fail, so a clean answer while it is open came from
    // the hash the stamp kept.
    [Fact]
    public void ABinaryWhoseStampHolds_ValidatesCleanWithoutARead()
    {
        Validate();

        using var held = new FileStream(_mod.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.Null(PluginBinaryHash.OfFile(_mod.Path));
        var report = Validate();

        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.Failures);
    }

    [Fact]
    public void ABinaryRewrittenOutsideModbench_NeedsARebuild()
    {
        var rewritten = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("WrittenByAnotherTool");
        rewritten.WriteToBinary(_mod.Path);

        var report = Validate();

        Assert.True(report.NeedsRebuild);
        Assert.Contains(_index.RequireReads().GetDocuments(_mod.KeyOf()), d => d.EditorId == "WrittenByAnotherTool");
    }

    [Fact]
    public void ABinaryDeletedOutsideModbench_TakesItsRowsWithIt()
    {
        File.Delete(_mod.Path);

        var report = Validate();

        Assert.False(report.NeedsRebuild);
        Assert.Empty(_index.Projected().GetDocuments(_mod.KeyOf()));
    }
}
