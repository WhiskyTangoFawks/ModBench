using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class DocumentFromTextTests
{
    private static readonly PluginAddress Elsewhere = new("Elsewhere.esp", PluginOrigin.DataDirectory);

    private static RecordDetail CopyFromText(OpenedIndex index, string formKey, string text) =>
        index.Queries.GetCompareRecords([new RecordCopy(formKey, Elsewhere, text)]).Value().Overrides.Single();

    private static PluginAddress PluginOf(RecordDetail copy) => new(copy.Plugin, copy.Origin);

    [Fact]
    public void ACopyReadFromText_HoldsTheFieldsOfTheText_UnderThePluginGiven()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var plugin = fixture.Plugins.Single().KeyOf();
        var stored = index.DocumentOf(npc.ToString(), plugin);
        var text = index.BodyOf(npc.ToString(), plugin).Replace("FixtureNpc", "EditedNpc", StringComparison.Ordinal);

        var copy = CopyFromText(index, npc.ToString(), text);

        Assert.NotNull(copy);
        Assert.Equal(("EditedNpc", Elsewhere, stored.RecordType), (copy.EditorId, PluginOf(copy), copy.RecordType));
        Assert.Equal(
            stored.Fields.Select(f => f.Metadata.Name), copy.Fields.Select(f => f.Metadata.Name));
        Assert.Equal(
            "EditedNpc", copy.Fields.Single(f => f.Metadata.Name == "EditorID").Value?.ToString());
    }

    [Fact]
    public void AFormKeyNoPluginIndexes_HasNoCopyToRead()
    {
        using var fixture = new PluginFixtureBuilder("document-from-text-unknown")
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);

        index.Queries.GetCompareRecords([new RecordCopy("00DEAD:Nowhere.esp", Elsewhere, "{}")]).Missing();
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("[]")]
    public void TextThatIsNoRecordDocument_IsACopyThatCouldNotBeParsed(string text)
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text-malformed")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var stored = index.DocumentOf(npc.ToString(), fixture.Plugins.Single().KeyOf());

        var copy = CopyFromText(index, npc.ToString(), text);

        Assert.NotNull(copy);
        Assert.False(string.IsNullOrWhiteSpace(copy.ParseDiagnosis));
        Assert.Equal((Elsewhere, stored.RecordType), (PluginOf(copy), copy.RecordType));
        Assert.All(copy.Fields, f => Assert.Null(f.Value));
    }

    [Fact]
    public void TextWhoseEditorIdIsNoString_IsACopyThatCouldNotBeParsed_NamingTheField()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text-editor-id")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var text = index.BodyOf(npc.ToString(), fixture.Plugins.Single().KeyOf())
            .Replace("\"FixtureNpc\"", "5", StringComparison.Ordinal);

        var copy = CopyFromText(index, npc.ToString(), text);

        Assert.NotNull(copy);
        Assert.Contains("'EditorID'", copy.ParseDiagnosis, StringComparison.Ordinal);
        Assert.Null(copy.EditorId);
    }
}
