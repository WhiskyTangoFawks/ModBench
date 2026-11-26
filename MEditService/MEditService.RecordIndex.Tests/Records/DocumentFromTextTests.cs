using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class DocumentFromTextTests
{
    [Fact]
    public void TextWhoseEditorIdIsNoString_IsACopyThatCouldNotBeParsed_NamingTheField()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text-editor-id")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var text = index.BodyOf(npc.ToString(), fixture.Plugins.Single().Key)
            .Replace("\"FixtureNpc\"", "5", StringComparison.Ordinal);

        var copy = index.Queries.GetCompareRecords([new RecordCopy(npc.ToString(), new PluginAddress("Elsewhere.esp", PluginOrigin.DataDirectory), text)])
            .Compared().Overrides.Single();

        Assert.Contains("'EditorID'", copy.ParseDiagnosis, StringComparison.Ordinal);
        Assert.Null(copy.EditorId);
    }
}
