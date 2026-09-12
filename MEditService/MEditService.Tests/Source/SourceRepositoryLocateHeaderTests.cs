using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>The header has no group folder and carries no FormKey in its file name, so every other
/// <see cref="SourceRepository.Locate"/> branch answers null for it.</summary>
public sealed class SourceRepositoryLocateHeaderTests
{
    [Fact]
    public void Locate_ForAHeaderFormKey_FindsTheRootRecordDataJson()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var unit = SourceRepository.Open(mod.ModFolder, GameRelease.Fallout4)!
            .Locate(mod.Plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null));

        Assert.NotNull(unit);
        Assert.False(unit!.Value.IsEmbedded);
        Assert.Equal(headerFormKey, unit.Value.OwnerFormKey);
        Assert.Equal(PluginHeader.RecordType, unit.Value.OwnerRecordType);
        Assert.Equal(
            Path.Combine(mod.ModFolder, "source", mod.ActualPluginName, "RecordData.json"), unit.Value.FullPath);
        Assert.True(File.Exists(unit.Value.FullPath), "Track already writes this file — resolution must find the real one.");
    }

    [Fact]
    public void Locate_ForAHeaderFormKey_IsNotDirectoryPerRecord()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var unit = SourceRepository.Open(mod.ModFolder, GameRelease.Fallout4)!
            .Locate(mod.Plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, EditorId: null));

        Assert.NotNull(unit);
        Assert.False(unit!.Value.IsDirectoryPerRecord);
    }
}
