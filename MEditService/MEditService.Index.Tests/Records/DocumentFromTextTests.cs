using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class DocumentFromTextTests
{
    private static readonly PluginAddress Elsewhere = new("Elsewhere.esp", "Data");

    [Fact]
    public void ACopyReadFromText_HoldsTheFieldsOfTheText_UnderThePluginAndLoadOrderIndexGiven()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();
        var stored = reads.GetDocument(npc.ToString(), fixture.Plugins.Single().KeyOf())
            ?? throw new InvalidOperationException("Expected the Npc to be indexed.");
        var text = (stored.Body ?? throw new InvalidOperationException("Expected a body.")).Replace("FixtureNpc", "EditedNpc", StringComparison.Ordinal);

        var copy = reads.DocumentFromText(npc.ToString(), Elsewhere, 7, text);

        Assert.NotNull(copy);
        Assert.Equal(("EditedNpc", Elsewhere, 7, stored.RecordType), (copy.EditorId, copy.Plugin, copy.LoadOrderIndex, copy.RecordType));
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

        Assert.Null(index.RequireReads().DocumentFromText("00DEAD:Nowhere.esp", Elsewhere, 7, "{}"));
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("[]")]
    public void TextThatIsNoJsonObject_IsAJsonException(string text)
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("document-from-text-malformed")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);

        Assert.ThrowsAny<System.Text.Json.JsonException>(
            () => index.RequireReads().DocumentFromText(npc.ToString(), Elsewhere, 7, text));
    }
}
