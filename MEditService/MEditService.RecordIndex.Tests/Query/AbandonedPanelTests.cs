using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class AbandonedPanelTests : IDisposable
{
    private const string Absent = "000ABC:Absent.esp";

    private ScatteredFixtureData? _fixture;

    public void Dispose() => _fixture?.Dispose();

    private ScatteredFixtureData Fixture => _fixture ?? throw new InvalidOperationException("Build the fixture first.");

    private void Build(Action<Fallout4Mod, string> fill, params string[] plugins)
    {
        var builder = new PluginFixtureBuilder("abandoned-panel");
        foreach (var name in plugins)
            builder.WithPlugin(name, mod => fill(mod, name), origin: $"{Path.GetFileNameWithoutExtension(name)}Mod");
        _fixture = builder.BuildScattered();
        SourceMods.CompiledPlugin(_fixture);
    }

    private sealed class LeavesAtItsFirstRead(ISourceAdapter inner, CancellationTokenSource caller, bool atOver) : DelegatingSourceAdapter(inner)
    {
        public bool Armed { get; set; }

        private void Leave()
        {
            if (Armed) caller.Cancel();
        }

        public override string TextOf(string sourceFolder, string path)
        {
            Leave();
            return base.TextOf(sourceFolder, path);
        }

        public override string TextAt(string path)
        {
            Leave();
            return base.TextAt(path);
        }

        public override ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release)
        {
            if (atOver) Leave();
            return base.Over(plugin, release);
        }
    }

    [Fact]
    public void AProblemsReadWhoseCallerLeftWhilePlacingOnePlugin_Stops()
    {
        Build((mod, _) => mod.Npcs.AddNew("Referrer").Race.SetTo(FormKey.Factory(Absent)), "First.esp", "Second.esp");
        using var left = new CancellationTokenSource();
        var source = new LeavesAtItsFirstRead(TestAdapters.Source(), left, atOver: false);
        using var index = Indexes.Reconciled(Fixture, source: source);
        source.Armed = true;

        Assert.Throws<OperationCanceledException>(() => index.Queries.GetProblems(null, null, left.Token));
    }

    [Fact]
    public void AFilePathsReadWhoseCallerLeftWhileReadingOnePlugin_Stops()
    {
        Build((mod, _) => mod.Npcs.AddNew("Referrer"), "First.esp", "Second.esp");
        using var left = new CancellationTokenSource();
        var source = new LeavesAtItsFirstRead(TestAdapters.Source(), left, atOver: true);
        using var index = Indexes.Reconciled(Fixture, source: source);
        source.Armed = true;

        Assert.Throws<OperationCanceledException>(() => index.Queries.GetFilePaths(null, null, left.Token));
    }

    [Fact]
    public void APlacedReferencesReadWhoseCallerLeftWhilePlacingOneCopy_Stops()
    {
        FormKey target = default;
        Build((mod, _) =>
        {
            target = mod.Keywords.AddNew("Target").FormKey;
            foreach (var name in new[] { "One", "Two" })
                mod.Npcs.AddNew(name).Keywords = [new FormLink<IKeywordGetter>(target)];
        }, "Compiled.esp");
        using var left = new CancellationTokenSource();
        var source = new LeavesAtItsFirstRead(TestAdapters.Source(), left, atOver: false);
        using var index = Indexes.Reconciled(Fixture, source: source);
        source.Armed = true;

        Assert.Throws<OperationCanceledException>(() => index.Queries.GetPlacedReferences(target.ToString(), left.Token));
    }
}
