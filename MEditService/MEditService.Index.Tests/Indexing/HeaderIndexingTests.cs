using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

// The plugin header is an ordinary document at the synthetic FormKey `000000:<plugin>`, whose
// body is the whole-mod door's root RecordData.json.
public class HeaderIndexingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    private static object? FieldValueOf(RecordDocument doc, string name) =>
        doc.Fields.Single(f => f.Metadata.Name == name).Value;

    // Declared masters are kept as declared: the default write recomputes them from the links the
    // records carry, and a header-only plugin carries none.
    private static PluginFixtureData OnePlugin(string prefix, string name, Action<Fallout4Mod>? configure = null) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(name, configure, writeParams: new BinaryWriteParameters { MastersListContent = MastersListContentOption.NoCheck, MastersListOrdering = MastersListOrderingOption.NoCheck })
            .Build();

    private static RecordDocument Header(IndexProjector index, string name) =>
        index.RequireReads().DocumentOf(PluginHeader.FormKeyFor(ModKey.FromFileName(name)), new PluginCopyKey(name, "Data"));

    [Fact]
    public void Index_Fo4Plugin_WritesHeaderDocument_WithSyntheticFormKeyAndHeaderType()
    {
        using var fixture = OnePlugin("header-row", "HeaderTest.esp");
        using var index = Indexes.Reconciled(fixture);

        var header = Header(index, "HeaderTest.esp");

        Assert.Equal("000000:HeaderTest.esp", header.FormKey);
        Assert.Equal("header", header.RecordType);
        // Headers have no EditorID concept — the one identity column that stays null.
        Assert.Null(header.EditorId);
        var entry = index.RequireReads().StackEntry(header.FormKey, header.Plugin);
        Assert.NotNull(entry);
        Assert.False(entry.HasWorkingTreeChange);
    }

    [Fact]
    public void Index_Header_BodyIsTheRootDocument()
    {
        using var fixture = OnePlugin("header-body", "BodyTest.esp", mod => mod.ModHeader.Author = "Vault Dweller");
        using var index = Indexes.Reconciled(fixture);

        var body = Header(index, "BodyTest.esp").BodyOf();

        // The root document's own shape, spelled out: the header nests one level inside a wrapper
        // carrying the mod's identity. This is what makes the header's column paths
        // "$.ModHeader.Author" rather than "$.Author".
        Assert.Contains("\"ModKey\": \"BodyTest.esp\"", body, StringComparison.Ordinal);
        Assert.Contains("\"GameRelease\": \"Fallout4\"", body, StringComparison.Ordinal);
        Assert.Contains("\"ModHeader\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Author\": \"Vault Dweller\"", body, StringComparison.Ordinal);
    }

    // The three fields the record editor renders for a header, read back through the ordinary document
    // path: each is the root document's own node at the column's path.
    [Fact]
    public void GetDocument_Header_AuthorField_MatchesModHeaderAuthor()
    {
        using var fixture = OnePlugin("header-author", "AuthorTest.esp", mod => mod.ModHeader.Author = "Vault Dweller");
        using var index = Indexes.Reconciled(fixture);

        var doc = Header(index, "AuthorTest.esp");
        Assert.Equal("Vault Dweller", Assert.IsType<JsonElement>(FieldValueOf(doc, "Author")).GetString());
    }

    [Fact]
    public void GetDocument_Header_FlagsField_ReflectsSmallMasterFlagForEsl()
    {
        using var fixture = OnePlugin("header-flags", "EslTest.esp", mod => mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small);
        using var index = Indexes.Reconciled(fixture);

        var doc = Header(index, "EslTest.esp");
        // The document spells the flags by Mutagen's member names.
        Assert.Equal(
            [nameof(Fallout4ModHeader.HeaderFlag.Small)],
            Assert.IsType<JsonElement>(FieldValueOf(doc, "Flags")).EnumerateArray().Select(e => e.GetString()));
    }

    [Fact]
    public void GetDocument_Header_MastersField_ListsPluginFilenamesInOrder()
    {
        using var fixture = OnePlugin("header-masters", "MastersTest.esp", mod =>
        {
            mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
            mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("DLCRobot.esm") });
        });
        using var index = Indexes.Reconciled(fixture);

        var doc = Header(index, "MastersTest.esp");
        // The document's own shape: one object per master, naming it.
        var masters = Assert.IsType<JsonElement>(FieldValueOf(doc, "MasterReferences"));
        Assert.Equal(
            ["Fallout4.esm", "DLCRobot.esm"],
            masters.EnumerateArray().Select(e => e.GetProperty("Master").GetString() ?? "").ToList());
    }

    [Fact]
    public void HeaderSchema_MastersColumn_IsReadOnlyWithAReason()
    {
        var masters = Reflector.GetSchemas(GameRelease.Fallout4)[PluginHeader.RecordType]
            .RecordColumns.Single(c => c.Name == "MasterReferences");

        Assert.False(string.IsNullOrWhiteSpace(masters.ReadOnlyReason));
    }

    [Fact]
    public async Task Index_ReIndexSamePlugin_ReplacesHeaderDocumentRatherThanDuplicating()
    {
        using var fixture = OnePlugin("header-reindex", "ReindexHeader.esp");
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginCopyKey("ReindexHeader.esp", "Data");

        await index.ReindexPlugin(key);

        var stack = index.RequireReads().GetOverrideStack("000000:ReindexHeader.esp");
        Assert.NotNull(stack);
        Assert.Single(stack.Entries);
        Assert.Single(index.RequireReads().GetDocuments(key), d => d.RecordType == PluginHeader.RecordType);
    }

    [Fact]
    public void Index_Header_Resolves_LikeEveryOtherRecord()
    {
        using var fixture = OnePlugin("header-lookup", "LookupHeader.esp", mod => mod.Npcs.AddNew().EditorID = "SomeNpc");
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();
        var key = new PluginCopyKey("LookupHeader.esp", "Data");

        var documents = reads.GetDocuments(key);
        // Positive control: more than just the header, or the sweep below is a 1==1 that would
        // hold even if records stopped resolving entirely.
        Assert.True(documents.Count > 1, $"expected the header and at least one record; got {documents.Count}");
        Assert.All(documents, d => Assert.NotNull(reads.Resolve(d.FormKey)));

        var resolved = reads.Resolve(PluginHeader.FormKeyFor(ModKey.FromFileName("LookupHeader.esp")));
        Assert.NotNull(resolved);
        Assert.Equal("header", resolved.Value.RecordType);
        Assert.Null(resolved.Value.EditorId);
    }

    [Fact]
    public void Index_TwoPlugins_EachGetsOwnHeaderDocument_NeitherOverridesTheOther()
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

    // ADR-0012: two origins holding the same filename — a filename-only delete step would make
    // indexing ModB's copy silently delete ModA's header document before inserting ModB's.
    [Fact]
    public void Index_TwoOrigins_SameFilename_EachGetsOwnHeaderDocument_NeitherOverridesTheOther()
    {
        using var fixture = new PluginFixtureBuilder("header-two-origins")
            .WithPlugin("Shared.esp", mod => mod.ModHeader.Author = "Author A", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.ModHeader.Author = "Author B", origin: "ModB")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);

        var overrideStack = index.RequireReads().GetOverrideStack("000000:Shared.esp")
            ?? throw new InvalidOperationException("Expected an override stack for Shared.esp's header.");
        var overrides = overrideStack.Entries;

        Assert.Equal(2, overrides.Count);
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModA");
        Assert.Contains(overrides, o => o.Plugin.Origin == "ModB");

        // ...and each carries its own author through, which is the fact a filename-scoped delete
        // would destroy.
        Assert.Equal("Author A", Assert.IsType<JsonElement>(FieldValueOf(overrides.Single(o => o.Plugin.Origin == "ModA").Effective, "Author")).GetString());
        Assert.Equal("Author B", Assert.IsType<JsonElement>(FieldValueOf(overrides.Single(o => o.Plugin.Origin == "ModB").Effective, "Author")).GetString());
    }
}
