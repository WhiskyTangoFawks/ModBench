using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Indexing;

public class HeaderIndexingTests
{
    private static object? FieldValueOf(RecordDetail doc, string name) =>
        doc.Fields.Single(f => f.Metadata.Name == name).Value;

    private static PluginFixtureData OnePlugin(string prefix, string name, Action<Fallout4Mod>? configure = null) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(name, configure)
            .Build();

    private static List<string> MastersOf(RecordDetail header) =>
        [.. Assert.IsType<JsonElement>(FieldValueOf(header, "MasterReferences")).EnumerateArray()
            .Select(e => e.GetProperty("Master").GetString() ?? "")];

    private static RecordDetail Header(OpenedIndex index, string name) =>
        index.DocumentOf(PluginHeader.FormKeyFor(ModKey.FromFileName(name)), new PluginAddress(name, PluginOrigin.DataDirectory));

    private static IReadOnlyList<RecordSummary> HeaderRows(OpenedIndex index, PluginAddress? plugin = null, string? search = null) =>
        index.Queries.GetRecords([PluginHeader.RecordType], plugin, search, limit: 10, offset: 0).Value().Items;

    [Fact]
    public void AFo4Plugin_HasAHeaderDocument_WithSyntheticFormKeyAndHeaderType()
    {
        using var fixture = OnePlugin("header-row", "HeaderTest.esp");
        using var index = Indexes.Reconciled(fixture);

        var header = Header(index, "HeaderTest.esp");

        Assert.Equal("000000:HeaderTest.esp", header.FormKey);
        Assert.Equal("header", header.RecordType);
        Assert.Null(header.EditorId);
        var row = Assert.Single(HeaderRows(index, new PluginAddress(header.Plugin, header.Origin), header.FormKey));
        Assert.Equal(WorkingTreeState.None, row.WorkingTreeState);
    }

    [Fact]
    public void TheHeaderDocumentsBody_IsTheRootDocument()
    {
        using var fixture = OnePlugin("header-body", "BodyTest.esp", mod => mod.ModHeader.Author = "Vault Dweller");
        using var index = Indexes.Reconciled(fixture);

        var body = index.BodyOf("000000:BodyTest.esp", new PluginAddress("BodyTest.esp", PluginOrigin.DataDirectory));

        Assert.Contains("\"ModKey\": \"BodyTest.esp\"", body, StringComparison.Ordinal);
        Assert.Contains("\"GameRelease\": \"Fallout4\"", body, StringComparison.Ordinal);
        Assert.Contains("\"ModHeader\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Author\": \"Vault Dweller\"", body, StringComparison.Ordinal);

        index.SetFilter("SELECT form_key FROM header WHERE \"Author\" = 'Vault Dweller'", "filter.sql");
        Assert.Single(HeaderRows(index));
        index.SetFilter("SELECT form_key FROM records WHERE record_type = 'header' AND json_extract_string(body, '$.Author') = 'Vault Dweller'", "filter.sql");
        Assert.Empty(HeaderRows(index));
    }

    [Fact]
    public void TheHeadersMastersField_ListsTheMastersItsRecordsRequire_InLoadOrder()
    {
        using var fixture = new PluginFixtureBuilder("header-masters")
            .WithPlugin("Zeta.esm", mod => mod.Npcs.AddNew("ZetaNpc"))
            .WithPlugin("Alpha.esm", mod => mod.Keywords.AddNew("AlphaKeyword"))
            .WithPlugin("MastersTest.esp", (mod, masters) =>
            {
                var overridden = mod.Npcs.GetOrAddAsOverride(masters[0].Npcs.Single());
                overridden.Keywords = [masters[1].Keywords.Single().ToLink()];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal(["Zeta.esm", "Alpha.esm"], MastersOf(Header(index, "MastersTest.esp")));
    }

    [Fact]
    public void TheHeadersMastersField_LeavesOutAMasterTheBinaryListsButNoRecordRequires()
    {
        using var fixture = new PluginFixtureBuilder("header-unrequired-master")
            .WithPlugin("Required.esm", mod => mod.Npcs.AddNew("RequiredNpc"))
            .WithPlugin("Unrequired.esm")
            .WithPlugin(
                "MastersTest.esp",
                (mod, masters) =>
                {
                    mod.Npcs.GetOrAddAsOverride(masters[0].Npcs.Single());
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = masters[0].ModKey });
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = masters[1].ModKey });
                },
                writeParams: new BinaryWriteParameters { MastersListContent = MastersListContentOption.NoCheck })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal(["Required.esm"], MastersOf(Header(index, "MastersTest.esp")));
    }

    [Fact]
    public void TheHeadersMastersField_FollowsTheWorkingTree_OfACompiledPlugin()
    {
        using var fixture = new PluginFixtureBuilder("header-masters-compiled-plugin")
            .WithPlugin("Kept.esm", mod => mod.Npcs.AddNew("KeptNpc"), origin: "KeptMod")
            .WithPlugin("Dropped.esm", mod => mod.Npcs.AddNew("DroppedNpc"), origin: "DroppedMod")
            .WithPlugin(
                "MastersTest.esp",
                (mod, masters) =>
                {
                    foreach (var master in masters) mod.Npcs.GetOrAddAsOverride(master.Npcs.Single());
                },
                origin: "MastersTestMod")
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture);
        var plugin = fixture.Plugins.Single(p => p.Name == "MastersTest.esp");
        var header = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        Assert.Equal(["Kept.esm", "Dropped.esm"], MastersOf(index.DocumentOf(header, plugin.Key)));

        var droppedOverride = index.ListedIn(plugin.Key).Single(d => d.EditorId == "DroppedNpc");
        index.Delete(plugin, index.DocumentOf(droppedOverride.FormKey, plugin.Key));

        Assert.Equal(["Kept.esm"], MastersOf(index.DocumentOf(header, plugin.Key)));
    }

    [Fact]
    public void TheHeadersMastersField_GainsAMasterAnEditedRecordLinksTo()
    {
        using var fixture = new PluginFixtureBuilder("header-masters-edited")
            .WithPlugin("Kept.esm", mod =>
            {
                mod.Npcs.AddNew("KeptNpc");
                mod.Keywords.AddNew("KeptKeyword");
            }, origin: "KeptMod")
            .WithPlugin("Linked.esm", mod => mod.Keywords.AddNew("LinkedKeyword"), origin: "LinkedMod")
            .WithPlugin(
                "MastersTest.esp",
                (mod, masters) => mod.Npcs.GetOrAddAsOverride(masters[0].Npcs.Single()).Keywords = [masters[0].Keywords.Single().ToLink()],
                origin: "MastersTestMod")
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture);
        var plugin = fixture.Plugins.Single(p => p.Name == "MastersTest.esp");
        var keptKeyword = index.ListedIn(fixture.Plugins.Single(p => p.Name == "Kept.esm").Key).Single(d => d.EditorId == "KeptKeyword");
        var linkedKeyword = index.ListedIn(fixture.Plugins.Single(p => p.Name == "Linked.esm").Key).Single(d => d.EditorId == "LinkedKeyword");
        var npc = index.DocumentOf(index.ListedIn(plugin.Key).Single(d => d.EditorId == "KeptNpc").FormKey, plugin.Key);

        index.Edit(plugin, npc, plugin.SourceTextOf(npc).Replace(keptKeyword.FormKey, linkedKeyword.FormKey, StringComparison.Ordinal));

        Assert.Equal(
            ["Kept.esm", "Linked.esm"],
            MastersOf(index.DocumentOf(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), plugin.Key)));
    }

    [Fact]
    public void ReindexingAPlugin_ReplacesItsHeaderDocumentRatherThanDuplicating()
    {
        using var fixture = OnePlugin("header-reindex", "ReindexHeader.esp");
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("ReindexHeader.esp", PluginOrigin.DataDirectory);

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextSnapshot();

        Assert.Single(index.StackOf("000000:ReindexHeader.esp"));
        Assert.Single(HeaderRows(index, key));
    }

    [Fact]
    public void TwoPlugins_EachHaveTheirOwnHeaderDocument_NeitherOverridesTheOther()
    {
        using var fixture = new PluginFixtureBuilder("header-two-plugins")
            .WithPlugin("PluginA.esp")
            .WithPlugin("PluginB.esp")
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal("PluginA.esp", Assert.Single(index.StackOf("000000:PluginA.esp")).Plugin);
        Assert.Equal("PluginB.esp", Assert.Single(index.StackOf("000000:PluginB.esp")).Plugin);
    }

    [Theory]
    [InlineData("ModA", "Author A")]
    [InlineData("ModB", "Author B")]
    public void TwoOriginsOfOneFilename_EachHaveTheirOwnHeaderDocument_NeitherOverridesTheOther(string winner, string author)
    {
        using var fixture = new PluginFixtureBuilder("header-two-origins")
            .WithPlugin("Shared.esp", mod => mod.ModHeader.Author = "Author A", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.ModHeader.Author = "Author B", origin: "ModB")
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var header = Assert.Single(index.WithWinner(holder, fixture.DataFolder, fixture.Plugins, winner)
            .StackOf("000000:Shared.esp"));

        Assert.Equal(winner, header.Origin);
        Assert.Equal(author, Assert.IsType<JsonElement>(FieldValueOf(header, "Author")).GetString());
    }
}
