using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class CompiledHeaderFollowsFileTests : IDisposable
{
    private const string Built = "Built.esp";
    private const string Master = "Base.esm";
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly LoadOrderHolder _holder = new();
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _built;
    private readonly OpenedIndex _index;

    public CompiledHeaderFollowsFileTests()
    {
        _fixture = new PluginFixtureBuilder("compiled-header-follows-file")
            .WithPlugin(Master, mod => mod.Npcs.AddNew("BaseNpc"), origin: "BaseMod")
            .WithPlugin(Built, mod => mod.Npcs.AddNew("BuiltNpc"), origin: "SourceMod")
            .BuildScattered();
        _built = _fixture.Plugins.Single(p => p.Name == Built);
        SourceMods.Init(_built);
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IReadOnlyList<string> MastersOfBuilt() =>
        _index.Queries.GetPlugins().Value().Single(p => p.Name == Built).Masters;

    private bool IsListed() => _index.Queries.GetPlugins().Value().Any(p => p.Name == Built);

    private void Rebuild() =>
        PluginBinaries.Rewrite(_built.Path, mod =>
        {
            mod.Npcs.Add(new Npc(FormKey.Factory($"000800:{Master}"), Fallout4Release.Fallout4));
            mod.Npcs.AddNew("BuiltNpc");
        });

    [Fact]
    public async Task ABuildThatAddedAMaster_IsReadBeforeTheReadOfItsWriteIsVouched()
    {
        Rebuild();
        _holder.SourceWritten([_built.Key]);
        var read = Task.Run(MastersOfBuilt);

        _index.SignalChange([_built.Key]);

        Assert.Equal([Master], await read.WaitAsync(Generous));
    }

    [Fact]
    public void ACompiledFileRewrittenOutsideModbench_ReachesItsMasters()
    {
        Rebuild();

        _index.SignalChange([_built.Key]);

        Waits.Reached(() => MastersOfBuilt().SequenceEqual([Master]), "the rewritten header");
    }

    [Fact]
    public async Task ABuildThatDroppedAMaster_IsReadBeforeTheReadOfItsWriteIsVouched()
    {
        Rebuild();
        _index.SignalChange([_built.Key]);
        Waits.Reached(() => MastersOfBuilt().SequenceEqual([Master]), "the master read");
        PluginBinaries.Rewrite(_built.Path, mod => mod.Npcs.AddNew("BuiltNpc"));
        _holder.SourceWritten([_built.Key]);
        var read = Task.Run(MastersOfBuilt);

        _index.SignalChange([_built.Key]);

        Assert.Empty(await read.WaitAsync(Generous));
    }

    [Fact]
    public void ACompiledFileThatIsGone_LeavesItsPluginUnlisted_AsOneNotYetRead()
    {
        File.Delete(_built.Path);

        _index.SignalChange([_built.Key]);

        Waits.Reached(() => !IsListed(), "the plugin unlisted");
    }
}
