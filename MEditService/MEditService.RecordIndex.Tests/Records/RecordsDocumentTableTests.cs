using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

[Collection(CutDownPluginCollection.Name)]
public sealed class RecordsDocumentTableTests(CutDownPluginFixture fixture)
{
    private static IModDisposeGetter OpenPlugin() => ModFactory.ImportGetter(
        new ModPath(ModKey.FromFileName(RealDataPlugin.PluginFileName), RealDataPlugin.PluginPath),
        GameRelease.Fallout4);

    private int DocumentsOf(string where) =>
        fixture.Index.Queries.SelectRows($"SELECT form_key FROM records WHERE {where}").Value().Rows.Length;

    [Fact]
    public void EveryIndexedRecordHasOneDocument()
    {
        using var overlay = OpenPlugin();
        const int theHeaderDocumentAddedBackBecauseAModHeaderIsNotAMajorRecordGetter = 1;
        var expectedMeasuredFromTheBinaryBecauseTheCuratedSliceIsRegenerable = overlay.EnumerateMajorRecords().Count()
            + theHeaderDocumentAddedBackBecauseAModHeaderIsNotAMajorRecordGetter;

        var actual = DocumentsOf("TRUE");

        Assert.True(expectedMeasuredFromTheBinaryBecauseTheCuratedSliceIsRegenerable > 0, "The cut-down plugin should contain records of indexed types.");
        Assert.Equal(expectedMeasuredFromTheBinaryBecauseTheCuratedSliceIsRegenerable, actual);
    }

    [Fact]
    public void EveryLandscapeAndNavmeshRecordHasOneDocument()
    {
        using var overlay = OpenPlugin();
        var landscapes = overlay.EnumerateMajorRecords<ILandscapeGetter>(throwIfUnknown: false).Count();
        var navmeshes = overlay.EnumerateMajorRecords<INavigationMeshGetter>(throwIfUnknown: false).Count();
        Assert.True(landscapes > 0 && navmeshes > 0,
            "Positive control: the cut-down plugin must hold LAND and NAVM records, counted by getter interface, "
            + "since a binary overlay's concrete type name would count none.");

        Assert.Equal(landscapes, DocumentsOf("record_type = 'land'"));
        Assert.Equal(navmeshes, DocumentsOf("record_type = 'navm'"));
    }

    [Fact]
    public void ADocument_CarriesItsIdentityColumns()
    {
        using var overlay = OpenPlugin();
        var record = ((IFallout4ModGetter)overlay).Npcs.First(n => n.EditorID != null);

        var document = fixture.Index.DocumentOf(record.FormKey.ToString(), CutDownPluginFixture.Plugin);

        Assert.Equal(CutDownPluginFixture.Plugin, new PluginAddress(document.Plugin, document.Origin));
        Assert.Equal("npc_", document.RecordType);
        Assert.Equal(record.EditorID, document.EditorId);
        Assert.Equal(0, document.LoadOrderIndex);
        Assert.True(document.IsWinner, "The only plugin indexed should win its own records.");
        var row = fixture.Index.RowOf(record.FormKey.ToString(), CutDownPluginFixture.Plugin);
        Assert.Equal(WorkingTreeState.None, row?.WorkingTreeState);
    }
}
