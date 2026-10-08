using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

public class HeaderIndexingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

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
        index.Records.GetRecords([PluginHeader.RecordType], plugin, search, limit: 10, offset: 0).Items;

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
    public void TheHeadersAuthorField_MatchesTheModHeaderAuthor()
    {
        using var fixture = OnePlugin("header-author", "AuthorTest.esp", mod => mod.ModHeader.Author = "Vault Dweller");
        using var index = Indexes.Reconciled(fixture);

        var doc = Header(index, "AuthorTest.esp");
        Assert.Equal("Vault Dweller", Assert.IsType<JsonElement>(FieldValueOf(doc, "Author")).GetString());
    }

    [Fact]
    public void TheHeadersFlagsField_ReflectsTheSmallMasterFlagForEsl()
    {
        using var fixture = OnePlugin("header-flags", "EslTest.esp", mod => mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small);
        using var index = Indexes.Reconciled(fixture);

        var doc = Header(index, "EslTest.esp");
        Assert.Equal(
            [nameof(Fallout4ModHeader.HeaderFlag.Small)],
            Assert.IsType<JsonElement>(FieldValueOf(doc, "Flags")).EnumerateArray().Select(e => e.GetString()));
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
    public void TheHeadersMastersField_FollowsTheWorkingTree_OfATrackedPlugin()
    {
        using var fixture = new PluginFixtureBuilder("header-masters-tracked")
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
            .Tracked();
        using var index = Indexes.Reconciled(fixture);
        var plugin = fixture.Plugins.Single(p => p.Name == "MastersTest.esp");
        var header = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        Assert.Equal(["Kept.esm", "Dropped.esm"], MastersOf(index.DocumentOf(header, plugin.KeyOf())));

        var droppedOverride = index.ListedIn(plugin.KeyOf()).Single(d => d.EditorId == "DroppedNpc");
        index.Delete(plugin, index.DocumentOf(droppedOverride.FormKey, plugin.KeyOf()));

        Assert.Equal(["Kept.esm"], MastersOf(index.DocumentOf(header, plugin.KeyOf())));
    }

    [Fact]
    public void HeaderSchema_MastersColumn_IsReadOnlyWithAReason()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType]
            .RecordColumns.Single(c => c.Name == "MasterReferences");

        Assert.False(string.IsNullOrWhiteSpace(masters.Field.ReadOnlyReason));
    }

    [Fact]
    public void HeaderSchema_MastersColumn_ReasonReachesEveryMemberBelow()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType]
            .RecordColumns.Single(c => c.Name == "MasterReferences").Field;

        var element = Assert.IsType<FieldMetadata>(masters.ElementType);
        Assert.Equal(masters.ReadOnlyReason, element.ReadOnlyReason);
        Assert.NotEmpty(element.Fields ?? []);
        Assert.All(element.Fields ?? [], member => Assert.Equal(masters.ReadOnlyReason, member.ReadOnlyReason));
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

    [Fact]
    public void TwoOriginsOfOneFilename_EachHaveTheirOwnHeaderDocument_NeitherOverridesTheOther()
    {
        using var fixture = new PluginFixtureBuilder("header-two-origins")
            .WithPlugin("Shared.esp", mod => mod.ModHeader.Author = "Author A", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.ModHeader.Author = "Author B", origin: "ModB")
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        foreach (var (origin, author) in new[] { ("ModA", "Author A"), ("ModB", "Author B") })
        {
            var header = Assert.Single(index.WithWinner(holder, fixture.GameDirectory, fixture.Plugins, origin)
                .StackOf("000000:Shared.esp"));
            Assert.Equal(origin, header.Origin);
            Assert.Equal(author, Assert.IsType<JsonElement>(FieldValueOf(header, "Author")).GetString());
        }
    }
}
