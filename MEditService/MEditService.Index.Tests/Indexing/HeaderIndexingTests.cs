using System.Text.Json;
using MEditService.Codec.Schema;
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

    private static object? FieldValueOf(RecordDocument doc, string name) =>
        doc.Fields.Single(f => f.Metadata.Name == name).Value;

    private static PluginFixtureData OnePlugin(string prefix, string name, Action<Fallout4Mod>? configure = null) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(name, configure)
            .Build();

    private static List<string> MastersOf(RecordDocument header) =>
        [.. Assert.IsType<JsonElement>(FieldValueOf(header, "MasterReferences")).EnumerateArray()
            .Select(e => e.GetProperty("Master").GetString() ?? "")];

    private static RecordDocument Header(OpenedIndex index, string name) =>
        index.RequireReads().DocumentOf(PluginHeader.FormKeyFor(ModKey.FromFileName(name)), new PluginAddress(name, "Data"));

    [Fact]
    public void AFo4Plugin_HasAHeaderDocument_WithSyntheticFormKeyAndHeaderType()
    {
        using var fixture = OnePlugin("header-row", "HeaderTest.esp");
        using var index = Indexes.Reconciled(fixture);

        var header = Header(index, "HeaderTest.esp");

        Assert.Equal("000000:HeaderTest.esp", header.FormKey);
        Assert.Equal("header", header.RecordType);
        Assert.Null(header.EditorId);
        var entry = index.RequireReads().StackEntry(header.FormKey, header.Plugin);
        Assert.NotNull(entry);
        Assert.False(entry.HasWorkingTreeChange);
    }

    [Fact]
    public void TheHeaderDocumentsBody_IsTheRootDocument()
    {
        using var fixture = OnePlugin("header-body", "BodyTest.esp", mod => mod.ModHeader.Author = "Vault Dweller");
        using var index = Indexes.Reconciled(fixture);

        var body = Header(index, "BodyTest.esp").BodyOf();

        Assert.Contains("\"ModKey\": \"BodyTest.esp\"", body, StringComparison.Ordinal);
        Assert.Contains("\"GameRelease\": \"Fallout4\"", body, StringComparison.Ordinal);
        Assert.Contains("\"ModHeader\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Author\": \"Vault Dweller\"", body, StringComparison.Ordinal);

        index.SetFilter("SELECT form_key FROM header WHERE \"Author\" = 'Vault Dweller'", "filter.sql");
        Assert.Single(index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [PluginHeader.RecordType], Limit: 10)).Items);
        index.SetFilter("SELECT form_key FROM records WHERE record_type = 'header' AND json_extract_string(body, '$.Author') = 'Vault Dweller'", "filter.sql");
        Assert.Empty(index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [PluginHeader.RecordType], Limit: 10)).Items);
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
        var reads = index.RequireReads();
        Assert.Equal(["Kept.esm", "Dropped.esm"], MastersOf(reads.DocumentOf(header, plugin.KeyOf())));

        var droppedOverride = reads.DocumentsOf(plugin.KeyOf()).Single(d => d.EditorId == "DroppedNpc");
        index.Delete(plugin, droppedOverride);

        Assert.Equal(["Kept.esm"], MastersOf(reads.DocumentOf(header, plugin.KeyOf())));
    }

    [Fact]
    public void HeaderSchema_MastersColumn_IsReadOnlyWithAReason()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType]
            .RecordColumns.Single(c => c.Name == "MasterReferences");

        Assert.False(string.IsNullOrWhiteSpace(masters.ReadOnlyReason));
    }

    [Fact]
    public void HeaderSchema_MastersColumn_ReasonReachesEveryMemberBelow()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType]
            .RecordColumns.Single(c => c.Name == "MasterReferences").ToFieldMetadata();

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
        var key = new PluginAddress("ReindexHeader.esp", "Data");

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextSnapshot();

        var stack = index.RequireReads().GetOverrideStack("000000:ReindexHeader.esp");
        Assert.NotNull(stack);
        Assert.Single(stack.Entries);
        Assert.Single(index.RequireReads().DocumentsOf(key), d => d.RecordType == PluginHeader.RecordType);
    }

    [Fact]
    public void TheHeader_Resolves_LikeEveryOtherRecord()
    {
        using var fixture = OnePlugin("header-lookup", "LookupHeader.esp", mod => mod.Npcs.AddNew().EditorID = "SomeNpc");
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();
        var key = new PluginAddress("LookupHeader.esp", "Data");

        var documents = reads.DocumentsOf(key);
        Assert.True(documents.Count > 1, $"expected the header and at least one record; got {documents.Count}");
        Assert.All(documents, d => Assert.NotNull(reads.Resolve(d.FormKey)));

        var resolved = reads.Resolve(PluginHeader.FormKeyFor(ModKey.FromFileName("LookupHeader.esp")));
        Assert.NotNull(resolved);
        Assert.Equal("header", resolved.Value.RecordType);
        Assert.Null(resolved.Value.EditorId);
    }

    [Fact]
    public void TwoPlugins_EachHaveTheirOwnHeaderDocument_NeitherOverridesTheOther()
    {
        using var fixture = new PluginFixtureBuilder("header-two-plugins")
            .WithPlugin("PluginA.esp")
            .WithPlugin("PluginB.esp")
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var overrideStackA = reads.GetOverrideStack("000000:PluginA.esp")
            ?? throw new InvalidOperationException("Expected an override stack for PluginA.esp's header.");
        var overrideStackB = reads.GetOverrideStack("000000:PluginB.esp")
            ?? throw new InvalidOperationException("Expected an override stack for PluginB.esp's header.");

        Assert.Single(overrideStackA.Entries);
        Assert.Single(overrideStackB.Entries);
        Assert.Equal("PluginA.esp", overrideStackA.Entries[0].Plugin.Name);
        Assert.Equal("PluginB.esp", overrideStackB.Entries[0].Plugin.Name);
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
            var header = Assert.Single(index.ReadsWithWinner(holder, fixture.GameDirectory, fixture.Plugins, origin)
                .GetOverrideStack("000000:Shared.esp")?.Entries ?? []);
            Assert.Equal(origin, header.Plugin.Origin);
            Assert.Equal(author, Assert.IsType<JsonElement>(FieldValueOf(header.Effective, "Author")).GetString());
        }
    }
}
