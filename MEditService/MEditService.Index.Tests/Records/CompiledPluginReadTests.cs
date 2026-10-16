using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class CompiledPluginReadTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("compiledPlugin-read")
        .WithPlugin("CompiledPlugin.esp", mod => mod.Npcs.AddNew("FromCompiledPlugin"), origin: "SourceMod")
        .WithPlugin("Plain.esp", mod => mod.Npcs.AddNew("FromPlain"), origin: "PlainMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public CompiledPluginReadTests()
    {
        SourceMods.Track(_fixture.Plugins.Single(p => p.Name == CompiledPlugin.Name));
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginAddress CompiledPlugin = new("CompiledPlugin.esp", "SourceMod");
    private static readonly PluginAddress Plain = new("Plain.esp", "PlainMod");

    private bool ReadsFromItsTree(PluginAddress plugin) =>
        _index.PluginRowOf(plugin) is { IsCompiledPlugin: true, PluginSourceUnreadable: null };

    [Fact]
    public void APluginIngestedFromItsSourceTree_ReadsAsDerivedFromIt()
    {
        Assert.True(ReadsFromItsTree(CompiledPlugin));
    }

    [Fact]
    public void APluginIngestedFromItsBytes_ReadsAsDerivedFromThem()
    {
        Assert.False(_index.PluginRowOf(Plain)?.IsCompiledPlugin ?? true);
    }

    [Fact]
    public void ALoadOrderNamingACompiledPluginInAnotherCase_StillReadsItAsDerivedFromItsTree()
    {
        var recased = new PluginAddress("SOURCEPLUGIN.ESP", "sourcemod");
        _index.Reconcile(_holder, _fixture.GameDirectory,
            [.. _fixture.Plugins.Select(p => p.Name == CompiledPlugin.Name ? p with { Name = recased.Name, Origin = recased.Origin } : p)],
            GameRelease.Fallout4);

        Assert.True(ReadsFromItsTree(recased));
    }

    [Fact]
    public void ACompiledPluginTheSnapshotStoppedNaming_IsAbsent()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [.. _fixture.Plugins.Where(p => p.Name != CompiledPlugin.Name)], GameRelease.Fallout4);

        Assert.Null(_index.PluginRowOf(CompiledPlugin));
    }
}
