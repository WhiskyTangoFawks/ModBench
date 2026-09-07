using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>The header has no group folder, is never a placement, and carries no FormKey in its
/// file name, so every other <see cref="SourceUnitResolver.Resolve"/> branch answers null for it.</summary>
public sealed class SourceUnitResolverHeaderTests
{
    [Fact]
    public void Resolve_ForAHeaderFormKey_FindsTheRootRecordDataJson()
    {
        using var mod = TrackedModFixture.Tracked();
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var reads = mod.Mirror.Projected();

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

    [Fact]
    public void Resolve_ForAHeaderFormKey_IsNotDirectoryPerRecord()
    {
        using var mod = TrackedModFixture.Tracked();
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));
        var reads = mod.Mirror.Projected();

        var unit = SourceUnitResolver.Resolve(
            reads, mod.Plugin, mod.ModFolder, headerFormKey, HeaderIndexer.RecordType, editorId: null,
            GameRelease.Fallout4);

        Assert.NotNull(unit);
        Assert.False(unit!.Value.IsDirectoryPerRecord);
    }
}
