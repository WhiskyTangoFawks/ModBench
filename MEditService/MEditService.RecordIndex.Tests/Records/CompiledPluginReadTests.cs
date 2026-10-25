using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class CompiledPluginReadTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("compiled-plugin-read")
        .WithPlugin("CompiledPlugin.esp", mod => mod.Npcs.AddNew("FromCompiledPlugin"), origin: "SourceMod")
        .WithPlugin("Plain.esp", mod => mod.Npcs.AddNew("FromPlain"), origin: "PlainMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public CompiledPluginReadTests()
    {
        SourceMods.Init(_fixture.Plugins.Single(p => p.Name == CompiledPlugin.Name));
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginAddress CompiledPlugin = new("CompiledPlugin.esp", "SourceMod");
    private static readonly PluginAddress Plain = new("Plain.esp", "PlainMod");

    [Fact]
    public void APluginIngestedFromItsSourceTree_ReadsAsDerivedFromIt()
    {
        Assert.True(_index.ReadFromItsPluginSource(CompiledPlugin));
    }

    [Fact]
    public void APluginIngestedFromItsBytes_ReadsAsDerivedFromThem()
    {
        Assert.False(_index.PluginResponseOf(Plain)?.IsCompiledPlugin ?? true);
    }

    [Fact]
    public void ALoadOrderNamingACompiledPluginInAnotherCase_StillReadsItAsDerivedFromItsTree()
    {
        var recased = new PluginAddress("COMPILEDPLUGIN.ESP", "sourcemod");
        _index.Reconcile(_holder, _fixture.DataFolder,
            [.. _fixture.Plugins.Select(p => p.Name == CompiledPlugin.Name ? p with { Name = recased.Name, Origin = recased.Origin } : p)],
            GameRelease.Fallout4);

        Assert.True(_index.ReadFromItsPluginSource(recased));
    }

    [Fact]
    public void ACompiledPluginTheSnapshotStoppedNaming_IsAbsent()
    {
        _index.Reconcile(_holder, _fixture.DataFolder, [.. _fixture.Plugins.Where(p => p.Name != CompiledPlugin.Name)], GameRelease.Fallout4);

        Assert.Null(_index.PluginResponseOf(CompiledPlugin));
    }
}
