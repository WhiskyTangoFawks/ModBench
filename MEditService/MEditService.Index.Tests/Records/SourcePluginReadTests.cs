using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class SourcePluginReadTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("sourcePlugin-read")
        .WithPlugin("SourcePlugin.esp", mod => mod.Npcs.AddNew("FromSourcePlugin"), origin: "SourceMod")
        .WithPlugin("Plain.esp", mod => mod.Npcs.AddNew("FromPlain"), origin: "PlainMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public SourcePluginReadTests()
    {
        SourceMods.Track(_fixture.Plugins.Single(p => p.Name == SourcePlugin.Name));
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginAddress SourcePlugin = new("SourcePlugin.esp", "SourceMod");
    private static readonly PluginAddress Plain = new("Plain.esp", "PlainMod");

    private bool ReadsFromItsTree(PluginAddress plugin) =>
        _index.PluginRowOf(plugin) is { IsSourcePlugin: true, PluginSourceUnreadable: null };

    [Fact]
    public void APluginIngestedFromItsSourceTree_ReadsAsDerivedFromIt()
    {
        Assert.True(ReadsFromItsTree(SourcePlugin));
    }

    [Fact]
    public void APluginIngestedFromItsBytes_ReadsAsDerivedFromThem()
    {
        Assert.False(_index.PluginRowOf(Plain)?.IsSourcePlugin ?? true);
    }

    [Fact]
    public void ALoadOrderNamingASourcePluginInAnotherCase_StillReadsItAsDerivedFromItsTree()
    {
        var recased = new PluginAddress("SOURCEPLUGIN.ESP", "sourcemod");
        _index.Reconcile(_holder, _fixture.GameDirectory,
            [.. _fixture.Plugins.Select(p => p.Name == SourcePlugin.Name ? p with { Name = recased.Name, Origin = recased.Origin } : p)],
            GameRelease.Fallout4);

        Assert.True(ReadsFromItsTree(recased));
    }

    [Fact]
    public void ASourcePluginTheSnapshotStoppedNaming_IsAbsent()
    {
        _index.Reconcile(_holder, _fixture.GameDirectory, [.. _fixture.Plugins.Where(p => p.Name != SourcePlugin.Name)], GameRelease.Fallout4);

        Assert.Null(_index.PluginRowOf(SourcePlugin));
    }
}
