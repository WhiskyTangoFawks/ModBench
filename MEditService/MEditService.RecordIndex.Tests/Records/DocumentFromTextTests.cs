using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class DocumentFromTextTests
{
    private static readonly PluginAddress Elsewhere = new("Elsewhere.esp", PluginOrigin.DataDirectory);

    private static RecordDetail CopyFromText(OpenedIndex index, string formKey, string text) =>
        index.Queries.GetCompareRecords([new RecordCopy(formKey, Elsewhere, text)]).Compared().Overrides.Single();

    private static PluginAddress PluginOf(RecordDetail copy) => new(copy.Plugin, copy.Origin);

    [Fact]
    public void ACopyReadFromText_HoldsTheFieldsOfTheText_UnderThePluginGiven()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var plugin = fixture.Plugins.Single().Key;
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

        var answer = index.Queries.GetCompareRecords([new RecordCopy("00DEAD:Nowhere.esp", Elsewhere, "{}")]).Value();

        Assert.NotEmpty(answer.Missing);
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
        var stored = index.DocumentOf(npc.ToString(), fixture.Plugins.Single().Key);

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
        var text = index.BodyOf(npc.ToString(), fixture.Plugins.Single().Key)
            .Replace("\"FixtureNpc\"", "5", StringComparison.Ordinal);

        var copy = CopyFromText(index, npc.ToString(), text);

        Assert.NotNull(copy);
        Assert.Contains("'EditorID'", copy.ParseDiagnosis, StringComparison.Ordinal);
        Assert.Null(copy.EditorId);
    }
}
