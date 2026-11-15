using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class HeldFailureInPanelsTests : IDisposable
{
    private const string Plugin = "Holding.esp";
    private const string StoppedAtFile = "is no record document";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly ThrowingTree _tree = new();
    private readonly OpenedIndex _index;

    public HeldFailureInPanelsTests()
    {
        _fixture = Compiled();
        _index = Indexes.Open(_holder, new FailsToOpen(PluginFailures.Unparsed(), atOpen: _ => true), source: _tree);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static ScatteredFixtureData Compiled() => new PluginFixtureBuilder("held-failure-in-panels")
        .WithPlugin(Plugin, mod =>
        {
            mod.TextureSets.AddNew("Holder").Diffuse = @"Decals\Stain_d.dds";
            mod.Npcs.AddNew("Referrer").Race.SetTo(FormKey.Factory("000ABC:Absent.esp"));
        }, origin: "HoldingMod")
        .BuildScattered()
        .CompiledPlugin();

    private static string HolderDocument(ScatteredFixtureData fixture) =>
        Directory.EnumerateFiles(PluginSourceRoot.In(fixture.Plugins.Single().ModFolderOf(), Plugin), "*.json", SearchOption.AllDirectories)
            .First(file => File.ReadAllText(file).Contains("\"Holder\"", StringComparison.Ordinal));

    private LoadOrderEntry Entry => _fixture.Plugins.Single();

    private void FailTheReRead(bool namingAFile)
    {
        var holder = HolderDocument(_fixture);
        if (namingAFile) File.WriteAllText(holder, "not a document");
        else
        {
            File.AppendAllText(holder, "\n");
            _tree.Throwing = true;
        }
        _index.SignalChange([Entry.Key]);
        Waits.Reached(() => _index.Status.Failures.Any(f => f.Name == Plugin), "the plugin's failure");
        _tree.Throwing = false;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void APluginHeldWithAFailure_IsAnsweredWithItsLastGoodRead_ByBothPanels_AndTheFilesThatStoppedItStayNamed(bool namingAFile)
    {
        FailTheReRead(namingAFile);
        var reason = Assert.Single(_index.Status.Failures).Reason;

        var paths = Assert.Single(_index.Queries.GetFilePaths(null).Value());
        var problems = Assert.Single(_index.Queries.GetProblems().Value());

        Assert.Equal((ProblemsFailureKind.LaterRead, ProblemsFailureKind.LaterRead), (paths.FailureKind, problems.FailureKind));
        Assert.Equal($"Showing the last good read: {reason}", paths.Failure);
        Assert.Equal($"Showing the last good read: {reason}", problems.Failure);
        Assert.Single(paths.Paths);
        Assert.NotEmpty(problems.Problems);
        Assert.Equal(namingAFile, paths.Unread.Any(file => file.Contains(StoppedAtFile, StringComparison.Ordinal)));
        Assert.Equal(namingAFile, problems.Problems.Any(problem => problem.Message.Contains(StoppedAtFile, StringComparison.Ordinal)));
    }

    [Fact]
    public void APluginWhoseFirstReadFailed_HasNoLastGoodReadToShow()
    {
        using var fixture = Compiled();
        File.WriteAllText(HolderDocument(fixture), "not a document");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new FailsToOpen(PluginFailures.Unparsed(), atOpen: _ => true));
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
        Waits.Reached(() => index.Status.Failures.Any(f => f.Name == Plugin), "the plugin's failure");

        var problems = Assert.Single(index.Queries.GetProblems().Value());

        Assert.Equal((null, null), (problems.Failure, problems.FailureKind));
        Assert.Empty(index.Queries.GetFilePaths(null).Value());
    }

    private sealed class ThrowingTree() : DelegatingSourceAdapter(TestAdapters.Source())
    {
        public volatile bool Throwing;

        public override ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
            Throwing ? throw new InvalidOperationException("The tree was made to fail.") : base.Over(plugin, release);
    }
}
