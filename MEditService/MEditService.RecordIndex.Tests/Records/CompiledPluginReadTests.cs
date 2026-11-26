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

    [Theory]
    [InlineData("CompiledPlugin.esp", "SourceMod", true)]
    [InlineData("Plain.esp", "PlainMod", false)]
    public void APluginRow_SaysWhetherItIsDerivedFromItsSourceTree(string name, string origin, bool compiled)
    {
        Assert.Equal(compiled, _index.PluginResponseOf(new PluginAddress(name, origin))?.IsCompiledPlugin);
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
}
