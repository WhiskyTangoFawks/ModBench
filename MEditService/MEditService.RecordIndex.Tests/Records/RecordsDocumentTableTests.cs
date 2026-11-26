using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
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
        fixture.Index.Queries.Selected($"SELECT form_key FROM records WHERE {where}").Length;

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
}
