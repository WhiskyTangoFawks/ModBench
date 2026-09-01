using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>
/// #661: the header is a first-class source unit. <see cref="SourceUnitResolver.Resolve"/> must find
/// its root <c>RecordData.json</c> directly — the header has no group folder to compute a flat path
/// under, is never a placement, and carries no FormKey in its file name for the fallback scan, which
/// is exactly why every one of <see cref="SourceUnitResolver.Resolve"/>'s existing branches answers
/// null for it (traced mechanically at plan time, not assumed).
/// </summary>
public sealed class SourceUnitResolverHeaderTests
{
    [Fact]
    public void Resolve_ForAHeaderFormKey_FindsTheRootRecordDataJson()
    {
        using var mod = TrackedModFixture.Tracked();
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var reads = mod.Mirror.Index!.At(RecordRef.Effective);

        var unit = SourceUnitResolver.Resolve(
            reads, mod.Plugin, mod.ModFolder, headerFormKey, HeaderIndexer.RecordType, editorId: null,
            GameRelease.Fallout4);

        Assert.NotNull(unit);
        Assert.False(unit!.Value.IsEmbedded);
        Assert.Equal(headerFormKey, unit.Value.OwnerFormKey);
        Assert.Equal(HeaderIndexer.RecordType, unit.Value.OwnerRecordType);
        Assert.Equal(
            Path.Combine(mod.ModFolder, "source", mod.ActualPluginName, "RecordData.json"), unit.Value.FullPath);
        Assert.True(File.Exists(unit.Value.FullPath), "Track already writes this file — resolution must find the real one.");
    }
}
