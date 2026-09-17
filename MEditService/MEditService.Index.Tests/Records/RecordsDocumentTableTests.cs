using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>What one plugin's documents are, measured against the binary they came from rather
/// than against literals: the curated slice is regenerable.</summary>
public sealed class RecordsDocumentTableTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private static IModDisposeGetter OpenPlugin() => ModFactory.ImportGetter(
        new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
        GameRelease.Fallout4);

    [Fact]
    public void Index_WritesOneDocumentPerRecordOfEveryIndexedType()
    {
        using var overlay = OpenPlugin();
        // The header is excluded from the enumeration, a ModHeader not being an IMajorRecordGetter, and
        // added back as the one ordinary document it contributes, so leaving it out would under-count
        // by exactly one per plugin.
        var expected = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)
            .Where(kv => kv.Key != PluginHeader.RecordType)
            .Sum(kv => overlay.EnumerateMajorRecords(kv.Value.RecordType, throwIfUnknown: false).Count())
            + 1;

        var actual = fixture.Reads.GetDocuments(CutDownPluginFixture.Plugin).Count;

        Assert.True(expected > 0, "The cut-down plugin should contain records of indexed types.");
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Index_ExcludesTheNonEditableRefTypesTheSchemaAlsoExcludes()
    {
        using var overlay = OpenPlugin();
        // By getter interface, not runtime type name: a binary overlay's concrete types are
        // LandscapeBinaryOverlay / NavigationMeshBinaryOverlay, so a name comparison here silently
        // counts zero and turns the control it is supposed to be into a no-op.
        var presentInPlugin = overlay.EnumerateMajorRecords<ILandscapeGetter>(throwIfUnknown: false).Count()
            + overlay.EnumerateMajorRecords<INavigationMeshGetter>(throwIfUnknown: false).Count();
        Assert.True(presentInPlugin > 0,
            "Positive control: the cut-down plugin must actually contain LAND/NAVM records for their absence to mean anything.");

        var reads = fixture.Reads;
        foreach (var excluded in (string[])["land", "navm", "navi"])
            Assert.Equal(0, reads.CountOf(CutDownPluginFixture.Plugin, excluded));
        Assert.True(reads.CountOf(CutDownPluginFixture.Plugin, "npc_") > 0,
            "Positive control: the same count must find documents of an indexed type.");
    }

    [Fact]
    public async Task Index_DocumentBody_IsTheCodecsSourceText()
    {
        using var overlay = OpenPlugin();
        var record = ((IFallout4ModGetter)overlay).Npcs.First();
        var expected = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(record, GameRelease.Fallout4);

        var document = fixture.Reads.GetDocument(record.FormKey.ToString(), CutDownPluginFixture.Plugin);

        Assert.NotNull(document);
        Assert.Equal(Encoding.UTF8.GetString(expected), document.Body);
    }

    [Fact]
    public void Index_Document_CarriesItsIdentityColumns()
    {
        using var overlay = OpenPlugin();
        var record = ((IFallout4ModGetter)overlay).Npcs.First(n => n.EditorID != null);

        var document = fixture.Reads.GetDocument(record.FormKey.ToString(), CutDownPluginFixture.Plugin);

        Assert.NotNull(document);
        Assert.Equal(CutDownPluginFixture.Plugin, document.Plugin);
        Assert.Equal("npc_", document.RecordType);
        Assert.Equal(record.EditorID, document.EditorId);
        Assert.Equal(0, document.LoadOrderIndex);
        Assert.True(document.IsWinner, "The only plugin indexed should win its own records.");
        var entry = fixture.Reads.StackEntry(record.FormKey.ToString(), CutDownPluginFixture.Plugin);
        Assert.NotNull(entry);
        Assert.False(entry.HasWorkingTreeChange, "An untracked copy's document is the committed one.");
    }
}
